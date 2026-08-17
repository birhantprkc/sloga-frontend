import { For, createResource, createSignal } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";

import { useClient } from "@revolt/client";
import {
  type SoundboardSoundInfo,
  ENTRANCE_NONE,
  fetchDefaultSounds,
  fetchServerSounds,
  soundboardClipUrl,
} from "@revolt/rtc/entranceSound";
import { useState } from "@revolt/state";
import {
  Column,
  FloatingSelect,
  IconButton,
  MenuItem,
  Row,
  Text,
} from "@revolt/ui";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

/** Sentinel option values — MenuItem cannot carry an empty value. */
const ALL_SERVERS = "__all__";
const NO_SOUND = "__none__";
/** "Use the all-servers choice" for a server row that has no override. */
const INHERIT = "__inherit__";

/**
 * Entrance sound (Discord parity): pick a soundboard sound that plays for
 * everyone when you join a server voice channel. "All servers" chooses from
 * the global Sloga Sounds (the only ones that exist in every server); a
 * specific server can override with any of its own sounds, or opt out.
 */
export function EntranceSoundOptions() {
  const client = useClient();
  const state = useState();
  const { t } = useLingui();

  const [serverId, setServerId] = createSignal(ALL_SERVERS);

  const [defaults] = createResource(() => fetchDefaultSounds(client()));
  const [serverSounds] = createResource(serverId, (id) =>
    id === ALL_SERVERS
      ? Promise.resolve([] as SoundboardSoundInfo[])
      : fetchServerSounds(client(), id),
  );

  const globalChoice = () =>
    state.settings.getValue("soundboard:entrance") ?? "";
  const overrides = () =>
    state.settings.getValue("soundboard:entrance_servers") ?? {};

  /** The select's value for the currently chosen server scope. */
  const current = () => {
    if (serverId() === ALL_SERVERS) return globalChoice() || NO_SOUND;
    const map = overrides();
    if (!Object.prototype.hasOwnProperty.call(map, serverId())) return INHERIT;
    return map[serverId()] || NO_SOUND;
  };

  function choose(value: string) {
    if (serverId() === ALL_SERVERS) {
      state.settings.setValue(
        "soundboard:entrance",
        value === NO_SOUND ? ENTRANCE_NONE : value,
      );
      return;
    }
    const map = { ...overrides() };
    if (value === INHERIT) delete map[serverId()];
    else map[serverId()] = value === NO_SOUND ? ENTRANCE_NONE : value;
    state.settings.setValue("soundboard:entrance_servers", map);
  }

  /** The concrete sound id the current scope resolves to (for preview). */
  const resolved = () => {
    const v = current();
    if (v === INHERIT) return globalChoice() || undefined;
    if (v === NO_SOUND) return undefined;
    return v;
  };

  let preview: HTMLAudioElement | undefined;
  function play() {
    const id = resolved();
    if (!id) return;
    preview?.pause();
    preview = new Audio(soundboardClipUrl(id));
    void preview.play().catch(() => {});
  }

  const label = (s: SoundboardSoundInfo) =>
    s.emoji ? `${s.emoji} ${s.name}` : s.name;

  /**
   * One flat option list. FloatingSelect walks its children by `.value`, so
   * a conditional (<Show>) child would hand it `undefined` and crash — the
   * "same as all servers" row is added to the array instead.
   */
  const soundOptions = () => {
    const rows: { value: string; text: string }[] = [];
    if (serverId() !== ALL_SERVERS)
      rows.push({ value: INHERIT, text: t`Same as all servers` });
    rows.push({ value: NO_SOUND, text: t`None` });
    for (const s of serverSounds() ?? [])
      rows.push({ value: s.id, text: label(s) });
    for (const s of defaults() ?? [])
      rows.push({ value: s.id, text: label(s) });
    return rows;
  };

  return (
    <Column>
      <Text class="title">
        <Trans>Entrance Sound</Trans>
      </Text>
      <Text class="label">
        <Trans>
          A soundboard sound that plays for everyone when you join a voice
          channel. It uses the soundboard, so it only plays where you are
          allowed to use it.
        </Trans>
      </Text>

      <FloatingSelect
        label={t`Server`}
        value={serverId()}
        onChange={(e) => setServerId(e.currentTarget.value ?? ALL_SERVERS)}
      >
        <MenuItem value={ALL_SERVERS}>
          <Trans>All servers</Trans>
        </MenuItem>
        <For each={client().servers.toList()}>
          {(server) => <MenuItem value={server.id}>{server.name}</MenuItem>}
        </For>
      </FloatingSelect>

      <Row align gap="sm">
        <div style={{ flex: 1, "min-width": 0 }}>
          <FloatingSelect
            label={t`Sound`}
            value={current()}
            onChange={(e) => choose(e.currentTarget.value ?? NO_SOUND)}
          >
            <For each={soundOptions()}>
              {(row) => <MenuItem value={row.value}>{row.text}</MenuItem>}
            </For>
          </FloatingSelect>
        </div>
        <IconButton
          variant="tonal"
          size="md"
          onPress={play}
          isDisabled={!resolved()}
          aria-label={t`Preview entrance sound`}
        >
          <Symbol>play_arrow</Symbol>
        </IconButton>
      </Row>
    </Column>
  );
}
