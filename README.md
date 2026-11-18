# YTD Playlist

App desktop para baixar playlists do YouTube em **MP3** ou **MP4**. Funciona no Windows, macOS e Linux.

- Busca de playlists, playlists salvas, fila de downloads com quantos downloads simultâneos você quiser
- Biblioteca com player integrado
- Tema claro / escuro / sistema
- Usa [yt-dlp](https://github.com/yt-dlp/yt-dlp), que é baixado e atualizado sozinho, e ffmpeg, que já vem embutido

## Rodar em desenvolvimento

```bash
npm install
npm start
```

## Gerar instalador local

```bash
npm run dist:win     # Windows (.exe instalador + portátil)
npm run dist:mac     # macOS (.dmg) — precisa rodar num Mac
npm run dist:linux   # Linux (.AppImage + .deb)
```

Os arquivos ficam em `dist/`.

## Releases automáticos (GitHub Actions)

O workflow [`.github/workflows/build.yml`](.github/workflows/build.yml) compila em 5 máquinas:

| Sistema | Arquivos |
|---|---|
| Windows x64 | instalador `.exe` + versão portátil `.exe` |
| macOS Apple Silicon | `.dmg` |
| macOS Intel | `.dmg` |
| Linux x64 | `.AppImage` + `.deb` |
| Linux ARM64 | `.AppImage` + `.deb` |

**Para publicar uma versão nova:**

```bash
git tag v1.0.0
git push origin v1.0.0
```

O GitHub compila tudo e cria o Release com os instaladores anexados. A versão do app vem da tag. Tags com hífen, como `v1.1.0-beta.1`, saem como pré-release.

Push na `main` e Pull Requests só compilam, para conferir se o build não quebrou. Na aba **Actions → Build e Release → Run workflow** dá pra compilar manualmente e baixar os arquivos em *Artifacts*.

### Sem certificado de assinatura

Os instaladores não são assinados com certificado pago. Por isso, na primeira vez:

- **Windows:** em "O Windows protegeu o computador", clique em *Mais informações → Executar assim mesmo*.
- **macOS:** se aparecer que o app está danificado, rode `xattr -cr "/Applications/YTD Playlist.app"`.
