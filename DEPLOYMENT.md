# Deploying PDF generation on Render

Invoice and settlement PDFs require Chrome. `.puppeteerrc.cjs` keeps the browser
in this project's `.cache/puppeteer` directory so the downloaded binary is included
in the deployed application. The default `/opt/render/.cache/puppeteer` home cache
can be missing at runtime. This follows the
[Puppeteer deployment cache guidance](https://pptr.dev/guides/configuration#changing-the-default-cache-directory).

For the existing Render backend service:

1. Deploy the updated backend repository. Commands must run from the directory
   containing this `package.json` (the repository root for the standalone backend,
   or `backend` if deploying from a combined repository).
2. Set **Build Command** to `npm ci && npm run build` and **Start Command** to
   `npm start`. Use Node.js 22.12 or newer, as required by Puppeteer 25.
3. Remove any old `PUPPETEER_CACHE_DIR` override pointing to `/opt/render/.cache/puppeteer`
   so the project configuration takes effect. For this managed Chrome setup, also
   remove `PUPPETEER_EXECUTABLE_PATH`, `PUPPETEER_SKIP_DOWNLOAD`, and
   `PUPPETEER_CHROME_SKIP_DOWNLOAD` overrides if present. A custom executable path
   is only needed when you separately install and manage Chrome on the server.
4. Select **Manual Deploy > Clear build cache & deploy** once to rebuild the
   browser installation with the new settings. See
   [Render's manual deployment options](https://render.com/docs/deploys#manual-deploys).
5. Confirm the build log includes `PDF browser check passed`, then download an
   invoice PDF and a settlement PDF from the deployed application.

`npm install` and `npm ci` install Puppeteer's matching Chrome version through
`postinstall`. `npm run build` explicitly ensures Chrome is installed and launches
it to generate a sample PDF, failing the build if the browser is missing or cannot
run. The check needs no database connection or Cloudinary credentials.

To run these steps locally:

```sh
npm ci
npm run build
```

Downloaded browsers are ignored by Git. No Chrome version or absolute server
executable path needs to be hardcoded.
