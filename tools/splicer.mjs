// The SPLICER preprocessor that build.mjs runs on every script it copies into a build:
// comment directives strip or inject code per build target (CLAUDE.md, "The SPLICER
// preprocessor"). It is a module of its own so the unit tests can run it without a build;
// build.mjs runs everything at load.

import {glob} from '../miniglob.mjs';
import fs from 'fs';
import path from 'path';
import * as url from 'url';

const __dirname = url.fileURLToPath(new URL('.', import.meta.url));
const chromeSourceDir = path.resolve(__dirname, '..', 'chrome');
const packageJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8'));

export function splice(fileText, target, relativePath) {
  const lines = fileText.split('\n');
  let newLines = [];
  let inSplicerRemove = false;
  let removedLines = 0;

  const initiatorStr = `SPLICER:${target}:`;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const index = line.indexOf(initiatorStr);
    if (index >= 0) {
      const command = line.substring(index + initiatorStr.length).trim();
      if (command === 'REMOVE_FILE') {
        console.log(`[Splicer-${target}] Removing file`, relativePath);
        return '';
      } else if (command === 'REMOVE_LINE') {
        console.log(`[Splicer-${target}] Removing line ${i + 1}`, relativePath);
        continue;
      } else if (command === 'REMOVE_START') {
        inSplicerRemove = true;
        removedLines = 0;
        continue;
      } else if (command === 'REMOVE_END') {
        if (!inSplicerRemove) {
          console.error(`[Splicer-${target}] Unmatched SPLICER:${target}:REMOVE_END`, relativePath);
          throw new Error('Unmatched SPLICER');
        }
        inSplicerRemove = false;
        console.log(`[Splicer-${target}] Removing lines ${i - removedLines}-${i + 1}`, relativePath);
        continue;
      } else if (command === 'INSERT_LOCALE') {
        const localesPath = path.join(chromeSourceDir, '_locales/');
        // get all locale folders
        const localeFolders = fs.readdirSync(localesPath);
        const locales = [];

        localeFolders.forEach((localeFolder) => {
          const localePath = path.join(localesPath, localeFolder, 'messages.json');
          // check if file exists
          if (!fs.existsSync(localePath)) {
            return;
          }

          const messages = JSON.parse(fs.readFileSync(localePath, 'utf8'));
          const translationMap = {};
          // Own-property reads only: a messages.json key like __proto__ must not reach
          // the lookup (CodeQL js/remote-property-injection).
          Object.keys(messages).forEach((key) => {
            if (!Object.hasOwn(messages, key)) return;
            translationMap[key] = messages[key] && messages[key].message;
          });
          locales.push({
            translationMap,
            code: localeFolder,
          });
        });

        // put english first
        const defaultLanguage = 'en';
        locales.sort((a, b) => {
          if (a.code === defaultLanguage) {
            return -1;
          } else if (b.code === defaultLanguage) {
            return 1;
          } else {
            return a.code.localeCompare(b.code);
          }
        });

        const newLocales = {};
        newLocales['LANGUAGES'] = locales.map((locale) => locale.code);
        const englishMap = locales[0].translationMap;
        Object.keys(englishMap).forEach((key) => {
          // Locales that predate a new key would otherwise inline `undefined`
          // and render blank strings on the web build; fall back to English.
          const translations = locales.map((locale) => locale.translationMap[key] || englishMap[key]);
          newLocales[key] = translations;
        });

        const localeText = JSON.stringify(newLocales, null, 2);
        newLines.push(localeText.substring(1, localeText.length - 1).trim());
        console.log(`[Splicer-${target}] Inserting locale`, relativePath);
        continue;
      } else if (command === 'INSERT_VERSION') {
        newLines.push(`version = '${packageJson.version}.web';`);
        console.log(`[Splicer-${target}] Inserting version`, relativePath);
        continue;
      }
    }

    if (inSplicerRemove) {
      removedLines++;
      continue;
    }

    newLines.push(line);
  }

  if (inSplicerRemove) {
    console.error(`[Splicer-${target}] Unmatched SPLICER:${target}:REMOVE_START`, relativePath);
    throw new Error('Unmatched SPLICER');
  }

  newLines = newLines.filter((line) => {
    return line.trim().length;
  });

  return newLines.join('\n');
}

export function spliceAndCopy(sourceDir, buildDir, spliceTargets = [], excludeFiles = []) {
  glob(sourceDir + '/**')
      .forEach((file) => {
        const fileExtension = path.extname(file);
        const relativePath = path.relative(sourceDir, file);
        const targetPath = path.resolve(buildDir, relativePath);
        const fileText = fs.readFileSync(file, 'utf8');

        // See if exclude files shares a prefix with the file
        for (let i = 0; i < excludeFiles.length; i++) {
          const excludeFile = excludeFiles[i];
          if (relativePath.startsWith(excludeFile)) {
            return;
          }
        }

        if (fileExtension === '.mjs' || fileExtension === '.js') {
          let spliced = fileText;

          spliceTargets.forEach((target) => {
            spliced = splice(spliced, target, relativePath);
          });

          if (spliced.length) {
            fs.mkdirSync(path.dirname(targetPath), {recursive: true});
            fs.writeFileSync(targetPath, spliced + '\n');
          }
        } else {
          fs.mkdirSync(path.dirname(targetPath), {recursive: true});
          fs.copyFileSync(file, targetPath);
        }
      });
}
