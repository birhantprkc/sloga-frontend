import { For, Show } from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";

import { useState } from "@revolt/state";
import {
  AVAILABLE_EXPERIMENTS,
  EXPERIMENTS,
} from "@revolt/state/stores/Experiments";
import { CategoryButton, Checkbox, Column } from "@revolt/ui";

/**
 * Advanced settings — developer-facing toggles. Lives in the Developer
 * section next to My Bots. Compact mode moved to Appearance › Messages,
 * where the other message-layout controls (and the live preview) are.
 */
export default function AdvancedSettings() {
  const state = useState();
  // The union is empty today, so indexing EXPERIMENTS by it types as never;
  // widen for the (currently unreachable) rows.
  const experiments = EXPERIMENTS as Record<
    string,
    { title: string; description: string }
  >;

  return (
    <Column gap="xl">
      <Column>
        <Checkbox
          checked={state.settings.getValue("advanced:copy_id")}
          onChange={(e) =>
            state.settings.setValue("advanced:copy_id", e.currentTarget.checked)
          }
        >
          <Trans>Show 'copy ID' in context menus</Trans>
        </Checkbox>
        <Checkbox
          checked={state.settings.getValue("advanced:admin_panel")}
          onChange={(e) =>
            state.settings.setValue(
              "advanced:admin_panel",
              e.currentTarget.checked,
            )
          }
        >
          <Trans>Show admin panel shortcuts in context menus</Trans>
        </Checkbox>
      </Column>
      {/* Only rendered when an experiment actually exists — an empty group
          used to draw two placeholder rows that toggled nothing. */}
      <Show when={AVAILABLE_EXPERIMENTS.length > 0}>
        <CategoryButton.Group>
          <For each={AVAILABLE_EXPERIMENTS}>
            {(key) => (
              <CategoryButton
                action={
                  <Checkbox
                    checked={state.experiments.isEnabled(key)}
                    onChange={(event) =>
                      state.experiments.setEnabled(
                        key,
                        event.currentTarget.checked,
                      )
                    }
                  />
                }
                description={experiments[key].description}
                onClick={() => void 0}
              >
                {experiments[key].title}
              </CategoryButton>
            )}
          </For>
        </CategoryButton.Group>
      </Show>
    </Column>
  );
}
