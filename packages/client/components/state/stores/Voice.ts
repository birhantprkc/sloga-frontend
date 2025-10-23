import { State } from "..";

import { AbstractStore } from ".";

export interface TypeVoice {
  preferredAudioInputDevice?: string;
  preferredAudioOutputDevice?: string;

  echoCancellation: boolean;
  noiseSupression: boolean;
}

/**
 * Handles enabling and disabling client experiments.
 */
export class Voice extends AbstractStore<"voice", TypeVoice> {
  /**
   * Construct store
   * @param state State
   */
  constructor(state: State) {
    super(state, "voice");
  }

  /**
   * Hydrate external context
   */
  hydrate(): void {
    /** nothing needs to be done */
  }

  /**
   * Generate default values
   */
  default(): TypeVoice {
    return {
      echoCancellation: true,
      noiseSupression: true
    };
  }

  /**
   * Validate the given data to see if it is compliant and return a compliant object
   */
  clean(input: Partial<TypeVoice>): TypeVoice {
    const data = this.default();

    if (typeof input.preferredAudioInputDevice === 'string') {
      data.preferredAudioInputDevice = input.preferredAudioInputDevice;
    }

    if (typeof input.preferredAudioOutputDevice === 'string') {
      data.preferredAudioOutputDevice = input.preferredAudioOutputDevice;
    }

    if (typeof input.echoCancellation === 'boolean') {
      data.echoCancellation = input.echoCancellation;
    }

    if (typeof input.noiseSupression === 'boolean') {
      data.noiseSupression = input.noiseSupression;
    }

    return data;
  }

  /**
   * Set the preferred audio input device
   */
  set preferredAudioInputDevice(value: string) {
    this.set('preferredAudioInputDevice', value);
  }

  /**
   * Set the preferred audio output device
   */
  set preferredAudioOutputDevice(value: string) {
    this.set('preferredAudioOutputDevice', value);
  }

  /**
   * Set echo cancellation
   */
  set echoCancellation(value: boolean) {
    this.set('echoCancellation', value);
  }

  /**
   * Set noise cancellation
   */
  set noiseSupression(value: boolean) {
    this.set('noiseSupression', value);
  }

  /**
   * Get the preferred audio input device
   */
  get preferredAudioInputDevice(): string | undefined {
    return this.get().preferredAudioInputDevice;
  }

  /**
   * Get the preferred audio output device
   */
  get preferredAudioOutputDevice(): string | undefined {
    return this.get().preferredAudioInputDevice;
  }

  /**
   * Get echo cancellation
   */
  get echoCancellation(): boolean | undefined {
    return this.get().echoCancellation;
  }

  /**
   * Get noise supression
   */
  get noiseSupression(): boolean | undefined {
    return this.get().noiseSupression;
  }
}
