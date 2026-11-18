// @ts-check
import {WebStorage} from './utils/WebStorage.mjs';
const savedColorTheme = WebStorage.get('local', 'faststream-color-theme');
if (savedColorTheme) {
  document.body.dataset.theme = savedColorTheme;
}
