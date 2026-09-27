# ChalkPal slideshow

`index.html` is the supplied 12-slide ChalkPal presentation, including its embedded fonts and speaker notes. It runs as a standalone static page without a build step or API keys.

## Present

Open `index.html` in a browser, or preview this directory with:

```sh
python3 -m http.server 4173 --directory docs --bind 127.0.0.1
```

Visit `http://localhost:4173`. Use the arrow keys, Space, or the on-screen buttons to navigate. Swipe on touch screens. Press **F** for full screen, **N** for speaker notes, **Home** for the first slide, or **End** for the last slide. Links such as `#5` open a specific slide.

## GitHub Pages

In this repository's **Settings → Pages**, select **Deploy from a branch**, choose **main** and **/docs**, then save. A repository administrator or maintainer must enable Pages initially. GitHub publishes subsequent changes from this directory automatically.

The site address is `https://ryankhalili.github.io/magic-whiteboard/`. Its homepage is the slideshow. `.nojekyll` keeps the supplied HTML unchanged during publication.

The interactive whiteboard continues to run with `npm run dev` from the repository root. Its Express backend and paid AI features require a server; GitHub Pages hosts the presentation only.
