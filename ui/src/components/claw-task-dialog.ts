import { html, nothing } from "lit";
import { t } from "../i18n/index.ts";
import { registerAgentDetailsClawsEnglish } from "../i18n/locales/en-agent-details-claws.ts";
import { formatUiError } from "../lib/format-error.ts";
import { generateUUID } from "../lib/uuid.ts";
import { withPromiseModalHost } from "./promise-modal-host.ts";
import "../styles/claw-task-dialog.css";

registerAgentDetailsClawsEnglish();

export type ClawChoice = { id: string; name: string };
export type ClawTaskRequest = { clawId: string; task: string; idempotencyKey: string };

export type ClawTaskDialogOptions = (
  | { /** Send this message: the dialog only asks which Claw. */ task: string; claws: ClawChoice[] }
  | { /** Run this Claw: the dialog only asks for the task. */ claw: ClawChoice }
) & {
  /** Starts the Claw. Text keeps the dialog open to retry; null closes it. */
  submit(request: ClawTaskRequest): Promise<string | null>;
};

let dialogActive = false;

function presentClawTaskDialog(options: ClawTaskDialogOptions): Promise<boolean> {
  return withPromiseModalHost<boolean>({ value: false }, (modal) => {
    const { host, finish, render } = modal;
    const fixedClaw = "claw" in options ? options.claw : null;
    const choices = "claws" in options ? options.claws : [];
    const title = fixedClaw
      ? t("agentDetails.claws.runTitle", { name: fixedClaw.name })
      : t("agentDetails.claws.pickTitle");
    let clawId = fixedClaw?.id ?? choices[0]?.id ?? "";
    let task = "task" in options ? options.task : "";
    let submitting = false;
    let failure: string | null = null;
    // A retry of the same Claw and text reuses its key, so the Gateway can answer with the
    // run an unconfirmed attempt may have started instead of starting a second one.
    let sent: { identity: string; key: string } | null = null;
    const blocked = () => !clawId || !task.trim();

    async function handleSubmit(event: Event) {
      event.preventDefault();
      if (submitting || blocked()) {
        return;
      }
      const request = { clawId, task: task.trim() };
      const identity = JSON.stringify(request);
      sent = sent?.identity === identity ? sent : { identity, key: generateUUID() };
      submitting = true;
      failure = null;
      paint();
      try {
        failure = await options.submit({ ...request, idempotencyKey: sent.key });
      } catch (error) {
        failure = formatUiError(error);
      }
      submitting = false;
      if (failure === null) {
        finish(true);
        return;
      }
      paint();
      host.querySelector<HTMLElement>("textarea, input:checked")?.focus();
    }

    // A pending request owns the dialog: closing it would hide whether the Claw started.
    const handleCancel = (event: Event) => (submitting ? event.preventDefault() : finish(false));

    const renderChoices = (claws: ClawChoice[]) => html`
      <p class="exec-approval-sub">${t("agentDetails.claws.pickHint")}</p>
      <fieldset class="claw-task-dialog__claws" aria-label=${title} ?disabled=${submitting}>
        ${claws.map(
          (claw, index) => html`<label class="claw-task-dialog__claw">
            <input
              type="radio"
              name="claw"
              .value=${claw.id}
              .checked=${claw.id === clawId}
              ?autofocus=${index === 0}
              @change=${() => {
                clawId = claw.id;
                paint();
              }}
            />
            <span>${claw.name}</span>
          </label>`,
        )}
      </fieldset>
    `;

    const renderTask = (name: string) => html`
      <p class="exec-approval-sub">${t("agentDetails.claws.runHint", { name })}</p>
      <label class="field claw-task-dialog__task">
        <span>${t("agentDetails.claws.runLabel", { name })}</span>
        <textarea
          name="task"
          rows="4"
          maxlength="16000"
          placeholder=${t("agentDetails.claws.runPlaceholder")}
          .value=${task}
          ?disabled=${submitting}
          aria-invalid=${failure ? "true" : nothing}
          autofocus
          @input=${(event: InputEvent) => {
            if (!(event.currentTarget instanceof HTMLTextAreaElement)) {
              return;
            }
            const wasBlocked = blocked();
            task = event.currentTarget.value;
            if (blocked() !== wasBlocked) {
              paint();
            }
          }}
          @keydown=${(event: KeyboardEvent) => {
            // Enter adds a line; Ctrl or Cmd with Enter runs, as in the chat composer.
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              void handleSubmit(event);
            }
          }}
        ></textarea>
      </label>
    `;

    function paint() {
      render(
        () => html`
          <openclaw-modal-dialog label=${title} @modal-cancel=${handleCancel}>
            <form class="exec-approval-card claw-task-dialog" @submit=${handleSubmit}>
              <div class="exec-approval-header">
                <div class="exec-approval-title">${title}</div>
              </div>
              ${fixedClaw ? renderTask(fixedClaw.name) : renderChoices(choices)}
              ${
                failure
                  ? html`<div class="exec-approval-error" role="alert">${failure}</div>`
                  : nothing
              }
              <div class="exec-approval-actions">
                <button type="submit" class="btn primary" ?disabled=${submitting || blocked()}>
                  ${fixedClaw ? t("agentDetails.claws.runSubmit") : t("agentDetails.claws.send")}
                </button>
                <button type="button" class="btn" ?disabled=${submitting} @click=${handleCancel}>
                  ${t("common.cancel")}
                </button>
              </div>
            </form>
          </openclaw-modal-dialog>
        `,
      );
    }

    paint();
  });
}

/**
 * Asks which Claw gets a message, or what a Claw should do, then starts it through `submit`.
 * Resolves true once a Claw started. A second request while one is open is refused.
 */
export function showClawTaskDialog(options: ClawTaskDialogOptions): Promise<boolean> {
  if (dialogActive) {
    return Promise.resolve(false);
  }
  dialogActive = true;
  return presentClawTaskDialog(options).finally(() => {
    dialogActive = false;
  });
}
