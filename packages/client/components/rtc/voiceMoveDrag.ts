import { createSignal } from "solid-js";

/**
 * Drag-to-move for voice participants.
 *
 * A moderator drags a participant row out of one voice channel's preview in
 * the server sidebar and drops it on another voice channel's row to move
 * that member there.
 *
 * The payload lives in a module-level signal rather than on the drag event:
 * HTML5 drag only exposes `dataTransfer.getData` during `drop` (the store is
 * in "protected mode" through `dragenter`/`dragover`), yet the drop targets
 * need to know who is being dragged, and from where, before then to decide
 * whether to highlight and accept. So the source (VoiceChannelPreview
 * participant rows) sets this on `dragstart` and clears it on `dragend`,
 * and the targets (ServerSidebar voice channel rows) read it.
 *
 * `dataTransfer.types` IS readable during `dragover`, so targets should also
 * require {@link VOICE_MOVE_MIME} there: `dragend` never reaches a source row
 * that unmounted mid-drag (the member left the call), and a stale signal
 * must not turn some unrelated drag into a move.
 *
 * This only drives the UI (highlighting, accepting the drop). It is never
 * authorization: whether the move is allowed is the server's decision.
 */
export interface DraggedVoiceParticipant {
  /** User being moved */
  userId: string;
  /** Voice channel they are being dragged out of */
  fromChannelId: string;
  /** Server both channels must belong to */
  serverId: string;
}

/**
 * Participant currently being dragged, or undefined when no voice-move drag
 * is in flight.
 */
export const [draggedVoiceParticipant, setDraggedVoiceParticipant] =
  createSignal<DraggedVoiceParticipant | undefined>(undefined);

/** Custom drag MIME type so file-drop layers and other drag handlers ignore it */
export const VOICE_MOVE_MIME = "application/x-sloga-voice-member";
