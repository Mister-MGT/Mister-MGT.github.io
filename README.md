# Mister-Wobbles.github.io

Landing page for Michael Thomson's NFC business card, served by GitHub Pages at <https://mister-wobbles.github.io/>.

## Files

| Path | What it is |
|---|---|
| `index.html` | The page: hero, contact rows, research summary. |
| `contact.vcf` | The vCard behind "Save contact". Everything in it is public. |
| `assets/site.css` | All styles. Colour tokens at the top (dark theme). |
| `assets/site.js` | Scroll reveals, Cape Town clock, share, copy-to-clipboard, toast. |
| `assets/plate.js` | The hero animation: an LPBF build of the MT monogram on a canvas. |
| `assets/favicon.svg` | Tab icon. |

No build step. Edit, commit, push to `main`, and Pages republishes in a minute or two.

## Adding projects

Add a "03 Projects" section where the comment in `index.html` marks it, reusing the `.rows` list markup, and put each project under `projects/<name>/index.html`, reusing `assets/site.css`.

## Preview locally

```
python -m http.server 4173
```

Then open <http://localhost:4173>.
