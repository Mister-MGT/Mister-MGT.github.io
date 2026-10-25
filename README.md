# Michael Thomson: contact page

Source for **<https://mister-mgt.github.io/>**, the page my NFC business card opens. Tap the card (or follow the link) to save my contact details, email or call me, or find me on LinkedIn.

I'm an MSc candidate in Mechanical Engineering at the University of Cape Town. My thesis is *Uncertainty Quantified Process-Property Maps for Ti-6Al-4V and Inconel 718*, on laser powder bed fusion (LPBF).

## About the animation

The block at the top of the page is a small simulation of an LPBF build. A laser hatches my initials into a powder bed, one layer at a time:

- Each layer is filled with back-and-forth scan lines, then the outline is traced.
- A recoater blade spreads fresh powder, and the next layer's scan angle rotates 67°, as on a real machine.
- The readout shows the layer number, build height (30 µm layers) and scan angle.

The animation is a plain 2D canvas drawn by [`assets/plate.js`](assets/plate.js). It pauses when off screen, and shows a finished, still build to anyone whose device is set to reduce motion.

## How it's built

Plain HTML, CSS and JavaScript. No framework, no build step and no tracking. GitHub Pages serves the files as they are.

| Path | Contents |
|---|---|
| [`index.html`](index.html) | The page |
| [`contact.vcf`](contact.vcf) | The contact card behind "Save contact" |
| [`assets/site.css`](assets/site.css) | Styles, with the colour and type tokens at the top |
| [`assets/site.js`](assets/site.js) | Scroll reveals, Cape Town clock, share and copy buttons |
| [`assets/plate.js`](assets/plate.js) | The LPBF build animation |

To run it locally, clone the repo and serve the folder:

```
python -m http.server 4173
```

Then open <http://localhost:4173>.

## Coming later

This page will grow into a portfolio of research and engineering projects.
