// @ts-check

/**
 * Where the player's sound goes: the system's default output, or a device the user chose
 * (his wish, 2026-10-24: headphones while the speakers stay the default, say).
 *
 * All of the player's sound runs through Web Audio (FastStreamClient.initiateWebAudio), and
 * Firefox has no AudioContext.setSinkId. It does have the element's setSinkId and
 * navigator.mediaDevices.selectAudioOutput (measured in Firefox 158 on an extension page,
 * top level and in a page's iframe with allow="speaker-selection"; without that attribute
 * both are refused). So for a chosen device the graph's end goes into a
 * MediaStreamAudioDestinationNode, whose stream a hidden <audio> plays on that device; for the
 * default output it stays on the context's own destination, as before, so a user who never
 * chooses gets nothing in between.
 *
 * The choice is kept (chrome.storage.local, 'audioOutputDevice') and applied to each video.
 * A device gone or no longer allowed falls back to the default output, and the caller says so.
 */

const STORAGE_KEY = 'audioOutputDevice';

/** @typedef {{deviceId: string, label: string}} OutputChoice */

/**
 * MediaDevices with Firefox's selectAudioOutput, which TypeScript's DOM types lack.
 * @typedef {MediaDevices & {selectAudioOutput: (options?: {deviceId?: string}) => Promise<MediaDeviceInfo>}} OutputMediaDevices
 */

/**
 * @typedef {Object} OutputGraph
 * @property {AudioContext} audioContext
 * @property {{connect: Function, disconnect: Function}} output - The graph's last node.
 */

export class AudioOutputDevice {
  /**
   * @param {Object} [io] - Stand-ins for tests.
   * @param {?OutputMediaDevices} [io.mediaDevices]
   * @param {() => HTMLAudioElement} [io.makeAudio]
   * @param {(key: string) => Promise<?string>} [io.load]
   * @param {(key: string, value: string) => Promise<void>} [io.save]
   */
  constructor({
    mediaDevices = typeof navigator !== 'undefined' ? /** @type {OutputMediaDevices} */ (navigator.mediaDevices) : null,
    makeAudio = () => new Audio(),
    load = async () => null,
    save = async () => {},
  } = {}) {
    this.mediaDevices = mediaDevices || null;
    this.makeAudio = makeAudio;
    this.load = load;
    this.save = save;
    /** @type {?OutputChoice} The device chosen; null for the default output. */
    this.choice = null;
    // Chosen or set back to the default in this page: the kept choice, read late, is older.
    this.decided = false;
    /** @type {?OutputChoice} What plays now: the choice once applied, else null. */
    this.playing = null;
    /** @type {?OutputGraph} */
    this.graph = null;
    /** @type {?MediaStreamAudioDestinationNode} */
    this.streamDestination = null;
    /** @type {?HTMLAudioElement} */
    this.element = null;
    this.channelCount = 2;
    // A later attach, choice or release makes an earlier one's late result moot.
    this.turn = 0;
    /** @type {?Promise<void>} */
    this.loaded = null;
    /** @type {?((choice: OutputChoice) => void)} Told when the device playing went away. */
    this.onGone = null;
    /** @type {?(() => void)} Told when the user chose (a device or the default): a notice is moot. */
    this.onChange = null;
    this.watching = false;
  }

  /** @return {boolean} Whether this Firefox can send the sound to another device. */
  isSupported() {
    return typeof this.mediaDevices?.selectAudioOutput === 'function' &&
      typeof HTMLMediaElement !== 'undefined' && typeof HTMLMediaElement.prototype.setSinkId === 'function';
  }

  /**
   * The choice kept from before, read once; a choice made in this page since stands.
   * @return {Promise<?OutputChoice>}
   */
  loadChoice() {
    if (!this.loaded) {
      this.loaded = this.load(STORAGE_KEY).then((text) => {
        if (this.decided) return;
        try {
          const parsed = text ? JSON.parse(text) : null;
          if (parsed && typeof parsed.deviceId === 'string' && parsed.deviceId) {
            this.choice = {deviceId: parsed.deviceId, label: String(parsed.label || '')};
          }
        } catch (e) {
          // A damaged entry: the default output.
        }
      }).catch(() => {});
    }
    return this.loaded.then(() => this.choice);
  }

  /**
   * A new video's graph: its sound goes to the default output at once, and to the chosen
   * device as soon as that is set up.
   * @param {AudioContext} audioContext
   * @param {{connect: Function, disconnect: Function}} output - The graph's last node.
   * @return {Promise<{failed: ?OutputChoice}>} failed: the choice that could not be applied.
   */
  async attach(audioContext, output) {
    this.release();
    this.graph = {audioContext, output};
    output.connect(audioContext.destination);
    const turn = ++this.turn;
    const choice = await this.loadChoice();
    if (!choice || turn !== this.turn || !this.isSupported()) return {failed: null};
    try {
      await this.route(choice, turn);
      return {failed: null};
    } catch (e) {
      // Overtaken meanwhile (another video, another choice): not this device's failure.
      if (turn !== this.turn) return {failed: null};
      console.warn('The chosen audio output is not available', e);
      this.toDefault();
      return {failed: choice};
    }
  }

  /**
   * Firefox's own chooser of output devices (it needs the user's click), then the sound there.
   * @return {Promise<?OutputChoice>} The device chosen, or null when the user cancelled or
   *   chose something else meanwhile.
   * @throws {Error} When the page may not choose (a site's permissions policy) or the device
   *   cannot play: the sound stays where it was.
   */
  async choose() {
    if (!this.isSupported()) throw new Error('This Firefox cannot choose the audio output');
    const known = this.choice?.deviceId;
    const devices = /** @type {OutputMediaDevices} */ (this.mediaDevices);
    let device;
    try {
      device = await devices.selectAudioOutput(known ? {deviceId: known} : {});
    } catch (e) {
      // A page whose permissions policy refuses it (Firefox names the policy); anything else
      // is the chooser closed without a choice, or no device to choose.
      if (isPolicyRefusal(e)) throw e;
      // The device asked for may be the one unplugged: the chooser again, nothing picked, so
      // the click that asked is not lost on it.
      if (!known || /** @type {Error} */ (e)?.name !== 'NotFoundError') return null;
      try {
        device = await devices.selectAudioOutput({});
      } catch (again) {
        if (isPolicyRefusal(again)) throw again;
        return null;
      }
    }
    const choice = {deviceId: device.deviceId, label: device.label || ''};
    const turn = ++this.turn;
    if (this.graph) await this.route(choice, turn);
    if (turn !== this.turn) return null;
    this.choice = choice;
    this.decided = true;
    this.onChange?.();
    await this.save(STORAGE_KEY, JSON.stringify(choice));
    return choice;
  }

  /** Back to the system's default output, and kept so. */
  async useDefault() {
    this.turn++;
    this.choice = null;
    this.decided = true;
    this.toDefault();
    this.onChange?.();
    await this.save(STORAGE_KEY, '');
  }

  /**
   * How many channels the graph's output has (AudioOutput.updateChannelCount): the detour
   * carries as many. Whether more than two reach the device through it is not established.
   * @param {number} count
   */
  setChannelCount(count) {
    this.channelCount = count;
    if (!this.streamDestination) return;
    try {
      this.streamDestination.channelCount = count;
    } catch (e) {
      // A count the node refuses: it keeps its own.
    }
  }

  /**
   * Sends the graph's sound to a device: the hidden element first, on that device and
   * playing, then the graph's end moved over to it, so no moment plays on both or neither.
   * Overtaken at any await (another video, another choice, the default), it does nothing more.
   * @param {OutputChoice} choice
   * @param {number} turn
   */
  async route(choice, turn) {
    const graph = /** @type {OutputGraph} */ (this.graph);
    const stale = () => turn !== this.turn || this.graph !== graph || graph.audioContext.state === 'closed';
    if (!this.streamDestination) {
      this.streamDestination = graph.audioContext.createMediaStreamDestination();
      this.setChannelCount(this.channelCount);
      this.element = this.makeAudio();
      this.element.srcObject = this.streamDestination.stream;
    }
    const element = /** @type {HTMLAudioElement} */ (this.element);
    await element.setSinkId(choice.deviceId);
    if (stale()) return;
    await element.play();
    if (stale() || this.element !== element) return;
    if (!this.playing) {
      graph.output.connect(this.streamDestination);
      graph.output.disconnect(graph.audioContext.destination);
    }
    this.playing = choice;
    this.watchDevices();
  }

  toDefault() {
    const graph = this.graph;
    if (graph && this.playing) {
      graph.output.connect(graph.audioContext.destination);
      graph.output.disconnect(this.streamDestination);
    }
    this.dropElement();
  }

  dropElement() {
    this.playing = null;
    if (this.element) {
      this.element.pause();
      this.element.srcObject = null;
    }
    this.element = null;
    this.streamDestination = null;
  }

  /**
   * A device unplugged while it plays: Firefox lists only the devices chosen in this page,
   * and one gone from its list is gone. The sound goes back to the default output, and onGone
   * says so.
   */
  watchDevices() {
    const devices = this.mediaDevices;
    if (this.watching || typeof devices?.addEventListener !== 'function' || typeof devices.enumerateDevices !== 'function') return;
    this.watching = true;
    devices.addEventListener('devicechange', () => this.checkDevices());
  }

  async checkDevices() {
    const playing = this.playing;
    if (!playing || !this.mediaDevices) return;
    let list;
    try {
      list = await this.mediaDevices.enumerateDevices();
    } catch (e) {
      return;
    }
    if (this.playing !== playing) return;
    if (list.some((device) => device.kind === 'audiooutput' && device.deviceId === playing.deviceId)) return;
    this.turn++;
    this.toDefault();
    this.onGone?.(playing);
  }

  /**
   * The video's graph goes (its context closes with it): the element stops, and nothing of
   * the graph is touched or kept.
   */
  release() {
    this.turn++;
    this.dropElement();
    this.graph = null;
  }
}

/**
 * Whether an error is a page's permissions policy refusing the choice (Firefox 158: "Document's
 * Permissions Policy does not allow selectAudioOutput()", or setSinkId()).
 * @param {*} e
 * @return {boolean}
 */
export function isPolicyRefusal(e) {
  return e?.name === 'NotAllowedError' && /permissions policy/i.test(String(e?.message));
}
