// express
import express from 'express';
import fs from 'fs';

const fileDir = './output';
const port = Number(process.env.PORT) || 3000;

const app = express();

const header = JSON.parse(fs.readFileSync(`${fileDir}/header.json`));
const numberOfEntries = header.number_of_entries;

// One lookup for every recorded path, not one route each: express reads a route's path
// as a pattern, where ':' starts a parameter, and express 5 rejects '(', ')' and '*'
// outright. A recorded URL can hold any of them.
const files = new Map();

console.log(`Serving ${numberOfEntries} entries`);
for (let i = 0; i < numberOfEntries; i++) {
  const entryHeader = JSON.parse(fs.readFileSync(`${fileDir}/${i}.json`));
  const dataLocation = entryHeader.responseType !== 'arraybuffer' ? `${i}.txt` : `${i}.bin`;

  const entryURL = entryHeader.url;
  const entryURLPath = new URL(entryURL).pathname;
  console.log(entryURLPath);

  // The first entry for a path wins, as the first route registered for it did.
  if (!files.has(entryURLPath)) files.set(entryURLPath, dataLocation);
}

// GET (and HEAD, which express answers for a GET route)
app.use((req, res, next) => {
  const dataLocation = req.method === 'GET' || req.method === 'HEAD' ? files.get(req.path) : undefined;
  if (!dataLocation) return next();
  // access control
  res.header('Access-Control-Allow-Origin', '*');
  res.sendFile(dataLocation, {
    root: fileDir,
  });
});


app.listen(port, () => {
  console.log(`Listening on port ${port}`);
});
