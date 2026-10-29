# sefera-social

@seferayazilim için Instagram gönderi ve story paylaşım betiği. Bağımlılık yok, Node 18+ yeterli.

## Klasör yapısı

```
posts/<YYYY-MM-DD>-<kisa-ad>/
  1.jpg, 2.jpg ...   yalnız JPEG (gönderi 1080x1350, story 1080x1920)
  caption.txt        gönderi metni (story'de yok)
  post.json          { "type": "feed" | "carousel" | "story" }
scripts/publish.mjs
```

Carousel en az 2, en çok 10 görsel alır. Feed ve story tam 1 görsel alır.

## Jeton

Jeton repoya konmaz. Repo dışında bir `.env` dosyası tutun:

```
IG_ACCESS_TOKEN=...
IG_USER_ID=...
```

## Kullanım

1. Görselleri commit edip `main`'e push edin. Instagram görseli
   `raw.githubusercontent.com` linkinden çeker; betik URL'nin 200 ve `image/jpeg`
   döndüğünü kontrol eder.
2. Kuru deneme (varsayılan, hiçbir şey paylaşmaz):

   ```
   node scripts/publish.mjs posts/2026-10-29-ornek --env C:\yol\.env
   ```

3. Gerçek paylaşım:

   ```
   node scripts/publish.mjs posts/2026-10-29-ornek --env C:\yol\.env --paylas
   ```

Başarılı paylaşımdan sonra `post.json` içine `publishedAt` ve `mediaId` yazılır.
`mediaId` olan klasör tekrar paylaşılmaz.
