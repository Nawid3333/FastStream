import {WebUtils} from '../../utils/WebUtils.mjs';
import {Knob} from '../../modules/knob.mjs';
import {Utils} from '../../utils/Utils.mjs';
import {DOMElements} from '../DOMElements.mjs';

export function createKnob(name, minValue, maxValue, callback, units = '') {
  const knobContainer = WebUtils.create('div', null, 'knob_container');
  const knobName = WebUtils.create('div', null, 'knob_name');
  knobName.textContent = name;
  knobContainer.appendChild(knobName);

  const knobMinValueTick = WebUtils.create('div', null, 'knob_min_value_tick');
  knobContainer.appendChild(knobMinValueTick);

  const knobMinValueLabel = WebUtils.create('div', null, 'knob_min_value_label');
  knobMinValueLabel.textContent = minValue;
  knobContainer.appendChild(knobMinValueLabel);

  const knobMaxValueTick = WebUtils.create('div', null, 'knob_max_value_tick');
  knobContainer.appendChild(knobMaxValueTick);

  const knobMaxValueLabel = WebUtils.create('div', null, 'knob_max_value_label');
  knobMaxValueLabel.textContent = maxValue;
  knobContainer.appendChild(knobMaxValueLabel);

  let suggestedValue = null;
  let suggestedValueTracking = false;
  const knobSuggestedValueTick = WebUtils.create('div', null, 'knob_suggested_value_tick');
  knobSuggestedValueTick.style.display = 'none';
  const suggestedValueTickDot = WebUtils.create('div', null, 'knob_suggested_value_tick_dot');
  knobSuggestedValueTick.appendChild(suggestedValueTickDot);
  knobContainer.appendChild(knobSuggestedValueTick);

  const knobKnobContainer = WebUtils.create('div', null, 'knob_knob_container');
  knobContainer.appendChild(knobKnobContainer);
  // The knob is a slider to the keyboard and to a screen reader. Only the value box was in
  // the tab order, and typing a number was the only way to turn it without a mouse.
  knobKnobContainer.tabIndex = 0;
  knobKnobContainer.role = 'slider';
  knobKnobContainer.ariaLabel = name;
  knobKnobContainer.setAttribute('aria-valuemin', minValue);
  knobKnobContainer.setAttribute('aria-valuemax', maxValue);

  const knobKnob = WebUtils.create('div', null, 'knob_knob');
  const knobBump = WebUtils.create('div', null, 'knob_bump');
  knobKnob.appendChild(knobBump);
  knobKnobContainer.appendChild(knobKnob);

  const knobValue = WebUtils.create('div', null, 'knob_value');
  knobContainer.appendChild(knobValue);
  knobValue.contentEditable = true;
  knobValue.role = 'textbox';
  knobValue.ariaLabel = name;
  knobValue.tabIndex = 0;


  const decimals = Utils.clamp(3 - Math.ceil(Math.log10(maxValue - minValue)), 0, 3);

  let shouldCall = false;
  const knob = new Knob(knobKnob, (knob, indicator)=>{
    knobKnob.style.transform = `rotate(-${indicator.angle}deg)`;
    knobKnobContainer.setAttribute('aria-valuenow', knob.val());
    knobKnobContainer.setAttribute('aria-valuetext', (knob.val().toFixed(decimals) + ' ' + units).trim());
    // dont update the value if the user is editing it
    if (knobValue !== document.activeElement) {
      knobValue.textContent = knob.val().toFixed(decimals) + ' ' + units;
    }
    if (shouldCall && callback) {
      checkValueIsSuggested();
      callback(knob.val(), suggestedValueTracking);
    }
  });

  function checkValueIsSuggested() {
    const val = knob.val();
    if (suggestedValue !== null && !isNaN(suggestedValue) && (isNaN(val) || Math.abs(val - suggestedValue) < (maxValue - minValue) * 0.02)) {
      suggestedValueTracking = true;
      suggestedValueTickDot.classList.add('tracking');
      const prevFlag = shouldCall;
      shouldCall = false;
      if (val !== suggestedValue) {
        knob.val(suggestedValue);
      }
      shouldCall = prevFlag;
    } else {
      suggestedValueTickDot.classList.remove('tracking');
      suggestedValueTracking = false;
    }
  }

  knobValue.addEventListener('input', ()=>{
    const val = parseFloat(knobValue.textContent.replace(units, ''));
    if (isNaN(val)) {
      return;
    }
    knob.val(val);
  });

  knobValue.addEventListener('keydown', (e)=>{
    if (e.key === 'Enter') {
      e.preventDefault();
      knobValue.blur();
    }
    e.stopPropagation();
  });

  knobValue.addEventListener('blur', (e)=>{
    const val = parseFloat(knobValue.textContent.replace(units, ''));
    // An emptied field goes to the suggested value, which the callback snaps NaN to. A knob
    // without one handed NaN on to its setting; it keeps its value instead.
    if (isNaN(val) && (suggestedValue === null || isNaN(suggestedValue))) {
      knobValue.textContent = knob.val().toFixed(decimals) + ' ' + units;
      return;
    }
    knob.val(val);
  });

  knob.options.indicatorAutoRotate = true;
  knob.options.angleEnd = 315;
  knob.options.angleStart = 45;
  knob.options.valueMin = minValue;
  knob.options.valueMax = maxValue;
  knob.val(minValue);

  setTimeout(()=>{
    shouldCall = true;
  }, 1);


  const container = knobKnobContainer;
  const rect = container.getBoundingClientRect();
  knob.setPosition(rect.left, rect.top);
  knob.setDimensions(50, 50);

  const mouseMove = (e) => {
    // No button held: it was let go where this drag never heard of it.
    if (e.buttons === 0) {
      mouseUp(e);
      return;
    }
    knob.doTouchMove([{
      pageX: e.pageX,
      pageY: e.pageY,
    }], e.timeStamp);
    e.preventDefault();
  };

  const mouseUp = (e) => {
    knob.doTouchEnd(e.timeStamp);
    DOMElements.playerContainer.removeEventListener('mousemove', mouseMove);
    DOMElements.playerContainer.removeEventListener('mouseup', mouseUp);
    document.removeEventListener('mouseup', mouseUp);
  };

  container.addEventListener('mousedown', (e) =>{
    // Only the left button turns the knob. A right-click's context menu takes the mouseup,
    // and the knob then followed the mouse until the next click.
    if (e.button !== 0) {
      return;
    }
    const rect = container.getBoundingClientRect();
    knob.setPosition(rect.left, rect.top);

    knob.doTouchStart([{
      pageX: e.pageX,
      pageY: e.pageY,
    }], e.timeStamp);

    DOMElements.playerContainer.addEventListener('mousemove', mouseMove);
    DOMElements.playerContainer.addEventListener('mouseup', mouseUp);
    // Let go outside the player: only the document hears that mouseup.
    document.addEventListener('mouseup', mouseUp);
  });

  // Handle scroll
  container.addEventListener('wheel', function(e) {
    // Wheel up turns the value up, wherever the pointer is on the knob. knob.mjs turns it
    // the other way on the knob's right half, and the centre it compared the pointer with
    // came from offsetLeft/offsetTop, relative to the knob's strip, while the pointer is in
    // page coordinates: the pointer was always "right", and wheel up turned the value down.
    // The knob's left edge stands for a pointer left of its centre.
    const rect = container.getBoundingClientRect();
    knob.setPosition(rect.left, rect.top);

    // deltaY, the standard one (wheelDelta is not): negative for wheel up, as -wheelDelta was.
    const delta = Utils.clamp(e.deltaY, -1, 1);
    knob.doMouseScroll(delta, e.timeStamp, rect.left, rect.top);

    e.preventDefault();
  });

  // The slider keys. A step is a fortieth of the range: a suggested value takes over within
  // 2% of it (checkValueIsSuggested), and a smaller step could never leave it again.
  container.addEventListener('keydown', (e) => {
    const step = (maxValue - minValue) / 40;
    const steps = {ArrowUp: step, ArrowRight: step, ArrowDown: -step, ArrowLeft: -step, PageUp: step * 10, PageDown: -step * 10};
    if (Object.hasOwn(steps, e.key)) {
      knob.val(knob.val() + steps[e.key]);
    } else if (e.key === 'Home') {
      knob.val(minValue);
    } else if (e.key === 'End') {
      knob.val(maxValue);
    } else {
      return;
    }
    // The arrows also seek the video.
    e.preventDefault();
    e.stopPropagation();
  });


  return {
    container: knobContainer,
    knob: knob,
    setSuggestedValue: (val) => {
      if (val !== null) {
        knobSuggestedValueTick.style.display = '';
        knobSuggestedValueTick.style.transform = `rotate(${(val - minValue) / (maxValue - minValue) * 270 + 45}deg)`;
        if (suggestedValueTracking) {
          const prevFlag = shouldCall;
          shouldCall = false;
          knob.val(val);
          shouldCall = prevFlag;
          if (shouldCall) callback(val, suggestedValueTracking);
        }
      } else {
        knobSuggestedValueTick.style.display = 'none';
      }
      suggestedValue = val;
      checkValueIsSuggested();
    },
  };
}
