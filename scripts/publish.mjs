#!/usr/bin/env node
// Instagram paylaşım betiği (@seferayazilim).
// Kullanım: node scripts/publish.mjs posts/<klasör> --env <yol> [--dry-run | --paylas]
// Varsayılan kuru denemedir; gerçek paylaşım yalnız --paylas ile yapılır.

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { resolve, relative, join, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const GRAPH = 'https://graph.facebook.com/v26.0';
const RAW_REPO = 'https://raw.githubusercontent.com/Kadirklnc0/sefera-social/';
let RAW_BASE = ''; // main yerine commit SHA: önbellek eski görseli vermesin
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SIZES = { feed: [1080, 1350], carousel: [1080, 1350], story: [1080, 1920] };
const POLL_MS = 3000;
const POLL_MAX_MS = 60000;

let TOKEN = '';

// Jeton hiçbir çıktıya karışmasın.
const redact = (s) => {
  let out = String(s);
  if (TOKEN) out = out.split(TOKEN).join('***');
  return out.replace(/access_token=[^&\s"]+/gi, 'access_token=***');
};
class Hata extends Error {}
const say = (m) => console.log(redact(m));
const fail = (m) => { throw new Hata(m); };

function parseArgs(argv) {
  const a = { dir: null, env: null, paylas: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--env') a.env = argv[++i];
    else if (v === '--dry-run') a.paylas = false;
    else if (v === '--paylas') a.paylas = true;
    else if (v.startsWith('--')) fail(`Bilinmeyen seçenek: ${v}`);
    else if (!a.dir) a.dir = v;
    else fail('Yalnız bir gönderi klasörü verilebilir.');
  }
  if (!a.dir || !a.env) {
    fail('Kullanım: node scripts/publish.mjs posts/<klasör> --env <yol> [--dry-run | --paylas]');
  }
  return a;
}

function loadEnv(path) {
  if (!existsSync(path)) fail('.env dosyası bulunamadı. --env yolunu kontrol edin.');
  const env = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  if (!env.IG_ACCESS_TOKEN) fail('.env içinde IG_ACCESS_TOKEN yok.');
  if (!env.IG_USER_ID) fail('.env içinde IG_USER_ID yok.');
  return env;
}

// JPEG imzası ve boyutu (SOF işaretçisinden).
function jpegSize(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker === 0xff) { i++; continue; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    const isSof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isSof) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}

function loadPost(dirArg) {
  const dir = resolve(dirArg);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) fail(`Klasör bulunamadı: ${dirArg}`);
  const rel = relative(REPO_ROOT, dir).split(sep).join('/');
  if (!rel.startsWith('posts/') || rel.split('/').length !== 2) {
    fail('Klasör posts/<YYYY-MM-DD>-<kisa-ad> biçiminde, bu reponun içinde olmalı.');
  }

  const jsonPath = join(dir, 'post.json');
  if (!existsSync(jsonPath)) fail('post.json bulunamadı.');
  let meta;
  try { meta = JSON.parse(readFileSync(jsonPath, 'utf8').replace(/^﻿/, '')); }
  catch { fail('post.json geçerli bir JSON değil.'); }
  const type = meta.type;
  if (!SIZES[type]) fail('post.json içindeki "type" feed, carousel veya story olmalı.');
  if (meta.mediaId) fail(`Bu gönderi zaten paylaşılmış (mediaId: ${meta.mediaId}). Çift paylaşımı önlemek için durdum.`);

  const files = readdirSync(dir)
    .filter((f) => /^\d+\.jpe?g$/i.test(f))
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  const others = readdirSync(dir).filter((f) => /\.(png|webp|gif|heic)$/i.test(f));
  if (others.length) fail(`Yalnız JPEG kabul edilir, şu dosyalar uygun değil: ${others.join(', ')}`);

  if (type === 'carousel') {
    if (files.length < 2) fail('Carousel için en az 2 görsel gerekir.');
    if (files.length > 10) fail('Carousel en çok 10 görsel içerebilir.');
  } else if (files.length !== 1) {
    fail(`${type} için tam olarak 1 görsel (1.jpg) gerekir; ${files.length} bulundu.`);
  }

  const [w, h] = SIZES[type];
  const images = files.map((f) => {
    const bytes = readFileSync(join(dir, f));
    const size = jpegSize(bytes);
    if (!size) fail(`${f} geçerli bir JPEG değil.`);
    if (size.width !== w || size.height !== h) {
      fail(`${f} boyutu ${size.width}x${size.height}; ${type} için ${w}x${h} olmalı.`);
    }
    const url = RAW_BASE + `${rel}/${f}`.split('/').map(encodeURIComponent).join('/');
    return { file: f, url, bytes: bytes.length };
  });

  let caption = '';
  if (type !== 'story') {
    const cp = join(dir, 'caption.txt');
    if (!existsSync(cp)) fail('Gönderi için caption.txt gerekir.');
    caption = readFileSync(cp, 'utf8').replace(/^﻿/, '').trim();
    if (!caption) fail('caption.txt boş.');
    if (caption.length > 2200) fail(`Metin ${caption.length} karakter; Instagram sınırı 2200.`);
  }
  return { jsonPath, meta, type, images, caption };
}

async function api(method, path, params = {}) {
  const url = new URL(GRAPH + path);
  const init = { method, headers: { Authorization: `Bearer ${TOKEN}` } };
  if (method === 'GET') {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  } else {
    init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    init.body = new URLSearchParams(params).toString();
  }
  let res;
  try { res = await fetch(url, init); }
  catch { fail('Instagram API\'ye bağlanılamadı. İnternet bağlantınızı kontrol edin.'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const e = data.error || {};
    let ipucu = '';
    if (e.code === 190) ipucu = ' (Jeton geçersiz veya süresi dolmuş.)';
    else if (e.code === 4 || e.code === 17 || e.code === 32) ipucu = ' (İstek sınırına ulaşıldı, sonra tekrar deneyin.)';
    else if (e.code === 10 || e.code === 200) ipucu = ' (Jetonda gerekli izin yok.)';
    fail(`Instagram API hatası [HTTP ${res.status}${e.code ? `, kod ${e.code}` : ''}]: ${e.message || 'bilinmeyen hata'}${ipucu}`);
  }
  return data;
}

function commitSha() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return fail('Git commit SHA\'sı okunamadı. Betik, klonlanmış repo içinde çalışmalı.');
  }
}

async function checkImageUrl({ file, url, bytes }) {
  let res;
  try { res = await fetch(url, { method: 'HEAD' }); }
  catch { return `${file}: URL'ye ulaşılamadı.`; }
  if (res.status !== 200) {
    return `${file}: URL ${res.status} döndü. Dosya GitHub'a push edilmemiş olabilir.`;
  }
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (!ct.startsWith('image/jpeg')) return `${file}: içerik türü "${ct || 'yok'}", image/jpeg olmalı.`;
  const len = Number(res.headers.get('content-length'));
  if (len && len !== bytes) {
    return `${file}: GitHub'daki dosya (${len} bayt) yerel dosyadan (${bytes} bayt) farklı. Değişiklik commit edilip push edilmemiş.`;
  }
  return null;
}

async function waitFinished(id, etiket) {
  const t0 = Date.now();
  for (;;) {
    const r = await api('GET', `/${id}`, { fields: 'status_code,status' });
    if (r.status_code === 'FINISHED') return;
    if (r.status_code === 'ERROR' || r.status_code === 'EXPIRED') {
      fail(`${etiket} işlenemedi (${r.status_code}${r.status ? `: ${r.status}` : ''}).`);
    }
    if (Date.now() - t0 > POLL_MAX_MS) fail(`${etiket} 60 saniyede hazır olmadı, işlem durduruldu.`);
    await new Promise((ok) => setTimeout(ok, POLL_MS));
  }
}

async function createContainer(uid, params, etiket) {
  const r = await api('POST', `/${uid}/media`, params);
  await waitFinished(r.id, etiket);
  return r.id;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = loadEnv(resolve(args.env));
  TOKEN = env.IG_ACCESS_TOKEN;
  const uid = env.IG_USER_ID;
  const dry = !args.paylas;

  const sha = commitSha();
  RAW_BASE = `${RAW_REPO}${sha}/`;
  say(`Görsel sürümü: commit ${sha.slice(0, 7)}`);
  const post = loadPost(args.dir);
  say(`Mod: ${dry ? 'KURU DENEME (paylaşım yapılmayacak)' : 'GERÇEK PAYLAŞIM'}`);
  say(`Tür: ${post.type}, görsel sayısı: ${post.images.length}`);

  // Salt okuma: bağlantı doğrulama
  const me = await api('GET', `/${uid}`, { fields: 'username' });
  say(`Hesap: @${me.username}`);

  // Salt okuma: kalan yayın hakkı
  let kalan = null;
  try {
    const lim = await api('GET', `/${uid}/content_publishing_limit`, { fields: 'quota_usage,config' });
    const d = lim.data?.[0];
    if (d) {
      const toplam = d.config?.quota_total;
      kalan = toplam != null ? toplam - d.quota_usage : null;
      say(`Yayın hakkı: ${d.quota_usage} kullanıldı${toplam != null ? `, kalan ${kalan}/${toplam}` : ''}`);
    }
  } catch (e) {
    say(`Uyarı: yayın hakkı okunamadı. ${e.message}`);
  }
  if (kalan !== null && kalan <= 0) fail('Bugünkü yayın hakkı dolmuş.');

  // Görsel URL kontrolü
  const sorunlar = (await Promise.all(post.images.map(checkImageUrl))).filter(Boolean);
  for (const img of post.images) say(`  ${img.file} → ${img.url}`);
  if (sorunlar.length) {
    for (const s of sorunlar) say(`  ✗ ${s}`);
    if (!dry) fail('Görsel URL kontrolü başarısız, paylaşım yapılmadı.');
  } else {
    say('Görsel URL\'leri: 200, image/jpeg ✓');
  }

  if (post.caption) say(`Metin (${post.caption.length} karakter):\n---\n${post.caption}\n---`);

  if (dry) {
    say(sorunlar.length
      ? 'Kuru deneme bitti: URL sorunları var, paylaşmadan önce düzeltin. Hiçbir şey paylaşılmadı.'
      : 'Kuru deneme bitti: her şey hazır. Hiçbir şey paylaşılmadı. Paylaşmak için --paylas ekleyin.');
    if (sorunlar.length) process.exitCode = 1;
    return;
  }

  let creationId;
  if (post.type === 'feed') {
    creationId = await createContainer(uid, { image_url: post.images[0].url, caption: post.caption }, 'Gönderi kapsayıcısı');
  } else if (post.type === 'story') {
    creationId = await createContainer(uid, { media_type: 'STORIES', image_url: post.images[0].url }, 'Story kapsayıcısı');
  } else {
    const children = [];
    for (const img of post.images) {
      say(`Yükleniyor: ${img.file}`);
      children.push(await createContainer(uid, { image_url: img.url, is_carousel_item: 'true' }, `${img.file} kapsayıcısı`));
    }
    creationId = await createContainer(uid, {
      media_type: 'CAROUSEL', children: children.join(','), caption: post.caption,
    }, 'Carousel kapsayıcısı');
  }

  const pub = await api('POST', `/${uid}/media_publish`, { creation_id: creationId });
  let permalink = '(alınamadı)';
  try { permalink = (await api('GET', `/${pub.id}`, { fields: 'permalink' })).permalink; } catch { /* yoksay */ }

  post.meta.publishedAt = new Date().toISOString();
  post.meta.mediaId = pub.id;
  writeFileSync(post.jsonPath, JSON.stringify(post.meta, null, 2) + '\n');

  say('Paylaşıldı ✓');
  say(`Medya kimliği: ${pub.id}`);
  say(`Bağlantı: ${permalink}`);
  say('post.json güncellendi.');
}

main().catch((e) => {
  console.error(redact(e instanceof Hata ? `Hata: ${e.message}` : `Beklenmeyen hata: ${e.message}`));
  process.exit(1);
});
