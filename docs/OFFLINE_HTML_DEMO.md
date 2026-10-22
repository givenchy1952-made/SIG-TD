# SIG-TD offline HTML demo

GitHub branch: demo/china-preview

This branch builds the existing SIG-TD React app into one standalone HTML file without live Supabase credentials.

Download procedure:
1. Open https://github.com/givenchy1952-made/SIG-TD/actions
2. Open the run named Build SIG-TD offline HTML demo for the demo/china-preview branch.
3. Wait until GitHub shows a green Success status.
4. Under Artifacts download SIG_TD_Offline_Demo.zip.
5. Extract SIG_TD_Offline_Demo.html and send it to the factory.
6. Open the downloaded HTML file from local storage with Chrome/Edge, not a Teams web preview.

The download artifact does not exist until a successful GitHub Actions build.
The HTML build and behavior in China have not yet been verified.
Demo data is saved in each browser separately, and edits will not synchronize across colleagues.
Production operations require server hosting and authentication. Do not use the HTML demo for real company data.

Build locally with Node 24:
npm ci
VITE_ENABLE_DEMO=true VITE_SUPABASE_URL= VITE_SUPABASE_ANON_KEY= npx vite build --config vite.offline.config.ts
node scripts/build-offline.mjs
Output: dist-offline/SIG_TD_Offline_Demo.html