import {WebUtils} from '../../utils/WebUtils.mjs';

export function createDropdown(defaultChoice, title, items, call, editableCallback = null) {
  const create = WebUtils.create;
  const container = create('div', null, 'dropdown');

  const text = create('div');
  text.appendChild(document.createTextNode(`${title}: `));
  const span = create('span', null, 'dropdown_text');
  span.contentEditable = editableCallback != null;
  span.textContent = items[defaultChoice];
  text.appendChild(span);
  text.appendChild(document.createTextNode(' ˅'));

  container.dataset.val = defaultChoice;
  container.tabIndex = 0;
  container.role = 'listbox';
  container.ariaLabel = title + ': ' + items[defaultChoice];
  container.appendChild(text);
  const itemListElement = create('div', `position: absolute; top: 100%; left: 0px; right: 0px;`, 'items');
  for (const name in items) {
    if (Object.hasOwn(items, name)) {
      const div = create('div');
      div.dataset.val = name;
      div.textContent = items[name];
      div.role = 'option';

      if (defaultChoice === name) {
        div.style.backgroundColor = 'var(--popwindow-dropdown-item-selected-background-color)';
      }
      itemListElement.appendChild(div);
    }
  }
  container.appendChild(itemListElement);
  setupDropdown(itemListElement, text, container, call, title);

  if (editableCallback) {
    span.style.cursor = 'text';
    span.addEventListener('input', (e) => {
      const value = span.textContent;
      // Nothing rebuilds the dropdown after an edit, so its list and label follow it here.
      renameDropdownChoice(container, value);
      editableCallback(container.dataset.val, value);
      e.stopPropagation();
    });

    span.addEventListener('keydown', (e)=>{
      if (e.key === 'Tab') {
        return;
      } else if (e.key === 'Enter') {
        span.blur();
      }
      e.stopPropagation();
    });

    span.addEventListener('click', (e) => {
      e.stopPropagation();
    });
  }
  return container;
}

/**
 * Shows a new name for the chosen item of a dropdown, in its field, its list and its label,
 * without rebuilding it: a rebuild under the pointer loses the click that is on its way.
 * @param {HTMLElement} container - The dropdown, from createDropdown.
 * @param {string} value - The name.
 */
export function renameDropdownChoice(container, value) {
  const text = container.children[0];
  const span = text.querySelector('.dropdown_text');
  // Set only when it differs, or the caret of an edit in progress would jump.
  if (span.textContent !== value) span.textContent = value;
  const item = Array.from(container.querySelector('.items').children).find((el) => el.dataset.val === container.dataset.val);
  if (item) item.textContent = value;
  // The label is the title's text node ("Profile: ") and the name.
  container.ariaLabel = text.firstChild.textContent + value;
}

<<<<<<< HEAD

=======
>>>>>>> upstream/main
function setupDropdown(itemListElement, text, container, call, title) {
  container.addEventListener('mouseleave', (e) => {
    container.blur();
  });

  container.addEventListener('mouseenter', (e) => {
    container.focus();
  });


  const main = text.children[0];

  function shiftSelection(indexAmount) {
    for (let j = 0; j < itemListElement.children.length; j++) {
      const element = itemListElement.children[j];
      if (element.dataset.val === container.dataset.val) {
        element.style.backgroundColor = '';
        const newIndex = (j + indexAmount + itemListElement.children.length) % itemListElement.children.length;
        const nextElement = itemListElement.children[newIndex];
        nextElement.style.backgroundColor = 'var(--popwindow-dropdown-item-selected-background-color)';
        main.textContent = nextElement.textContent;
        container.dataset.val = nextElement.dataset.val;
        // As a click on an item does, or a screen reader keeps the old value.
        container.ariaLabel = title + ': ' + nextElement.textContent;
        if (call) call(container.dataset.val, element.dataset.val);
        break;
      }
    }
  }

  container.addEventListener('click', (e) => {
    shiftSelection(1);
    e.stopPropagation();
  });

  container.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' ) {
      shiftSelection(1);
      e.preventDefault();
      e.stopPropagation();
    } else if (e.key === 'ArrowUp') {
      shiftSelection(-1);
      e.preventDefault();
      e.stopPropagation();
    } else if (e.key === 'Enter') {
      shiftSelection(1);
      e.preventDefault();
      e.stopPropagation();
    }
  });

  for (let i = 0; i < itemListElement.children.length; i++) {
    ((i) => {
      const el = itemListElement.children[i];

      el.addEventListener('click', (e) => {
        main.textContent = el.textContent;
        const prevValue = container.dataset.val;
        container.dataset.val = el.dataset.val;

        for (let j = 0; j < itemListElement.children.length; j++) {
          if (j === i) {
            itemListElement.children[j].style.backgroundColor = 'var(--popwindow-dropdown-item-selected-background-color)';
          } else {
            itemListElement.children[j].style.backgroundColor = '';
          }
        }
        e.stopPropagation();
        container.ariaLabel = title + ': ' + el.textContent;
        if (call) call(container.dataset.val, prevValue);
      });
    })(i);
  }
}
