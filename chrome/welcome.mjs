// @ts-check
import {Localize} from './player/modules/Localize.mjs';
import {OptionsStore} from './player/options/OptionsStore.mjs';
import {ComputerMemorySizes, memorySizeLabel, optionsForComputerMemory} from './player/options/RamGuard.mjs';
import {StorageModes, storageModeOf} from './player/options/StorageMode.mjs';
import {StringUtils} from './player/utils/StringUtils.mjs';

const sizes = /** @type {HTMLElement} */ (document.getElementById('ramsizes'));
const answer = /** @type {HTMLElement} */ (document.getElementById('ramset'));

/**
 * The answer given, here or in the options.
 * @param {Object<string, *>} options
 */
function showAnswer(options) {
  for (const button of sizes.querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String(Number(button.dataset.gb) === options.computerMemory));
  }
  const set = options.computerMemory > 0 && options.ramBudget > 0;
  // What happens beyond it is the storage mode's: the disk, or downloaded again.
  const mode = storageModeOf({ramBudget: options.ramBudget, bufferToDisk: options.bufferToDisk});
  const key = mode === StorageModes.RAM_ONLY ? 'welcome_page_ram_set_ramonly' : 'welcome_page_ram_set';
  answer.textContent = set ? Localize.getMessage(key, [StringUtils.formatSize(options.ramBudget)]) : '';
  answer.hidden = !set;
}

for (const gigabytes of ComputerMemorySizes) {
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.gb = String(gigabytes);
  button.textContent = memorySizeLabel(gigabytes);
  button.addEventListener('click', async () => {
    // The stored options first: a save from defaults would put them back over the user's.
    const options = {...await OptionsStore.init(), ...optionsForComputerMemory(gigabytes)};
    showAnswer(options);
    await OptionsStore.replace(options);
  });
  sizes.append(button);
}

OptionsStore.subscribe(showAnswer);
OptionsStore.init().then(() => showAnswer(OptionsStore.get()), (e) => console.error('Loading the saved options failed', e));
