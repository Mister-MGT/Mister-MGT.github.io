# Mister-Wobbles.github.io

Landing page for Michael Thomson's NFC business card, served by GitHub Pages at <https://mister-wobbles.github.io/>.

## Files

| Path | What it is |
|---|---|
| `index.html` | The page. Contact rows, research summary, projects placeholder. |
| `contact.vcf` | The vCard behind "Save contact". Everything in it is public. |
| `assets/site.css` | All styles. Colour tokens at the top, light and dark themes. |
| `assets/site.js` | Scroll reveals, Cape Town clock, share, copy-to-clipboard, toast. |
| `assets/plate.js` | The hero animation: an LPBF build of the MT monogram on a canvas. |
| `assets/favicon.svg` | Tab icon. |

No build step. Edit, commit, push to `main`, and Pages republishes in a minute or two.

## Adding projects

`index.html` has a commented project-row template inside the Projects section. Replace the "In the build queue" card with rows like it, and put each project under `projects/<name>/index.html`, reusing `assets/site.css`.

## Preview locally

```
python -m http.server 4173
```

Then open <http://localhost:4173>.
