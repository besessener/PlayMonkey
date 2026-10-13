import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserContext, Dialog, Download, FileChooser, Page } from "playwright";
import { Random } from "./random.ts";
import { NASTY_VALUES } from "./values.ts";

/** Something the page did during a step that needed an answer or produced a file. Recorded with the step. */
export type StepEvent =
  | {
      kind: "dialog";
      /** `alert`, `confirm`, `prompt` or `beforeunload`. */
      dialog: string;
      message: string;
      accepted: boolean;
      /** What was typed into a `prompt`. */
      text?: string;
    }
  | { kind: "upload"; files: string[] }
  | {
      kind: "download";
      /** The file name the site suggested. */
      name: string;
      url: string;
      /** Bytes saved; absent when the download failed. */
      size?: number;
      /** Why the download failed, e.g. `canceled`; the `download` oracle reports it. */
      failure?: string;
    };

/** A small generated file the monkey offers to file choosers. */
export interface UploadFile {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

/** A 1×1 transparent PNG. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

/** Valid and invalid files: empty, 1 MiB, a wrong extension, a unicode name, an image that is not one. */
export const UPLOAD_FILES: readonly UploadFile[] = [
  { name: "monkey.txt", mimeType: "text/plain", buffer: Buffer.from("PlayMonkey was here.\n") },
  { name: "monkey.png", mimeType: "image/png", buffer: PNG },
  { name: "empty.txt", mimeType: "text/plain", buffer: Buffer.alloc(0) },
  { name: "large-1mb.bin", mimeType: "application/octet-stream", buffer: Buffer.alloc(1024 * 1024, 0x6d) },
  { name: "invoice.pdf.exe", mimeType: "application/x-msdownload", buffer: Buffer.from("MZ not really a program") },
  { name: "not-an-image.png", mimeType: "image/png", buffer: Buffer.from("this is text, not a PNG") },
  { name: "Zoë 日本語 🐒.txt", mimeType: "text/plain", buffer: Buffer.from("unicode name\n") },
];

/** Text typed into `prompt` dialogs when the monkey does not pick a nasty value. */
const PROMPT_VALUES = ["monkey", "42", ""];

/** Mixed into the seed, so answering pages does not shift the monkey's own action sequence. */
const EVENT_SEED_SALT = 0x5e_ed_d1_a1;

export interface PageEventOptions {
  seed: number;
  /** Downloads are saved here (created on the first one); without it they are only measured and deleted. */
  downloadDir?: string;
  /** How long `collect` waits for answers, uploads and downloads still in progress. */
  timeoutMs: number;
}

/**
 * Answers what pages ask for and keeps what they hand out, on every page of a context, popups included:
 *
 * - **Native dialogs** (`alert`, `confirm`, `prompt`, `beforeunload`) are accepted or dismissed at random, a prompt
 *   gets generated text. A dialog is never left open: an open dialog blocks the page.
 * - **File choosers** (a click on a file input, or a button that opens one) get one of `UPLOAD_FILES`, sometimes two
 *   when the input takes several.
 * - **Downloads** are saved to `downloadDir` and measured; a failed one is recorded with its failure.
 *
 * Choices come from a generator seeded from the run's seed, independent of the monkey's own. During a replay, the
 * recorded answers of the step are given again (`beginStep`). `collect` returns the events of the current step.
 */
export class PageEvents {
  readonly #context: BrowserContext;
  readonly #options: PageEventOptions;
  readonly #random: Random;
  readonly #pending = new Set<Promise<void>>();
  #events: StepEvent[] = [];
  #step = 0;
  /** Recorded events of the step being replayed, consumed in order. */
  #recorded: StepEvent[] | undefined;
  #detached = false;
  #downloads = 0;

  constructor(context: BrowserContext, options: PageEventOptions) {
    this.#context = context;
    this.#options = options;
    this.#random = new Random((options.seed ^ EVENT_SEED_SALT) >>> 0);
    for (const page of context.pages()) this.#watch(page);
    context.on("page", this.#watch);
  }

  /** The next events belong to `step`; `recorded` are the answers to give during a replay of it. */
  beginStep(step: number, recorded?: StepEvent[]): void {
    if (step === this.#step) return;
    this.#step = step;
    this.#recorded = recorded === undefined ? undefined : [...recorded];
  }

  /** Waits up to the timeout for work in progress, then returns the events since the last call. */
  async collect(): Promise<StepEvent[]> {
    if (this.#pending.size > 0) {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, this.#options.timeoutMs);
      });
      await Promise.race([Promise.allSettled([...this.#pending]), timeout]);
      clearTimeout(timer);
    }
    const events = this.#events;
    this.#events = [];
    return events;
  }

  /** Stops listening; events that arrive later are dropped. */
  detach(): void {
    this.#detached = true;
    this.#context.off("page", this.#watch);
    for (const page of this.#context.pages()) this.#unwatch(page);
  }

  readonly #watch = (page: Page): void => {
    page.on("dialog", this.#onDialog);
    page.on("filechooser", this.#onFileChooser);
    page.on("download", this.#onDownload);
  };

  #unwatch(page: Page): void {
    page.off("dialog", this.#onDialog);
    page.off("filechooser", this.#onFileChooser);
    page.off("download", this.#onDownload);
  }

  #track(work: Promise<void>): void {
    const tracked = work.catch(() => undefined).finally(() => this.#pending.delete(tracked));
    this.#pending.add(tracked);
  }

  #push(event: StepEvent): void {
    if (!this.#detached) this.#events.push(event);
  }

  /** The next recorded event of `kind`, during a replay. */
  #replayed<K extends StepEvent["kind"]>(kind: K): Extract<StepEvent, { kind: K }> | undefined {
    const index = this.#recorded?.findIndex((event) => event.kind === kind) ?? -1;
    if (index < 0) return undefined;
    return this.#recorded?.splice(index, 1)[0] as Extract<StepEvent, { kind: K }>;
  }

  readonly #onDialog = (dialog: Dialog): void => {
    const recorded = this.#replayed("dialog");
    const accepted = recorded?.accepted ?? this.#random.chance(0.5);
    const isPrompt = dialog.type() === "prompt";
    const text = isPrompt && accepted ? (recorded?.text ?? this.#promptValue()) : undefined;
    this.#push({
      kind: "dialog",
      dialog: dialog.type(),
      message: dialog.message(),
      accepted,
      ...(text === undefined ? {} : { text }),
    });
    // Answered at once: a dialog left open blocks every further call to the page.
    this.#track(accepted ? dialog.accept(text) : dialog.dismiss());
  };

  readonly #onFileChooser = (chooser: FileChooser): void => {
    const recorded = this.#replayed("upload");
    let files: UploadFile[];
    if (recorded === undefined) {
      files = [this.#random.pick(UPLOAD_FILES)];
      if (chooser.isMultiple() && this.#random.chance(0.3)) {
        const second = this.#random.pick(UPLOAD_FILES);
        if (second !== files[0]) files.push(second);
      }
    } else {
      files = recorded.files.map(
        (name) => UPLOAD_FILES.find((file) => file.name === name) ?? (UPLOAD_FILES[0] as UploadFile),
      );
    }
    this.#push({ kind: "upload", files: files.map((file) => file.name) });
    this.#track(
      chooser.setFiles(
        files.map((file) => ({ ...file })),
        { timeout: this.#options.timeoutMs },
      ),
    );
  };

  readonly #onDownload = (download: Download): void => {
    const step = this.#step;
    this.#track(this.#save(download, step));
  };

  async #save(download: Download, step: number): Promise<void> {
    const name = download.suggestedFilename();
    const url = download.url();
    const failure = await download.failure();
    if (failure !== null) {
      this.#push({ kind: "download", name, url, failure });
      return;
    }
    let size: number | undefined;
    const { downloadDir } = this.#options;
    if (downloadDir === undefined) {
      const path = await download.path();
      size = (await stat(path)).size;
      await download.delete();
    } else {
      await mkdir(downloadDir, { recursive: true });
      this.#downloads++;
      const path = join(downloadDir, `step-${String(step).padStart(4, "0")}-${this.#downloads}-${safeFileName(name)}`);
      await download.saveAs(path);
      size = (await stat(path)).size;
    }
    this.#push({ kind: "download", name, url, size });
  }

  #promptValue(): string {
    return this.#random.chance(0.5) ? this.#random.pick(PROMPT_VALUES) : this.#random.pick(NASTY_VALUES);
  }
}

/** Removes the downloads of a run unless they are to be kept. */
export async function removeDownloads(downloadDir: string): Promise<void> {
  await rm(downloadDir, { recursive: true, force: true });
}

/** One line per event for logs, e.g. `confirm dismissed`, `upload empty.txt`, `download report.csv (28 bytes)`. */
export function describeEvent(event: StepEvent): string {
  switch (event.kind) {
    case "dialog":
      return `${event.dialog} ${event.accepted ? "accepted" : "dismissed"}${event.text === undefined ? "" : ` with ${JSON.stringify(event.text.length > 40 ? `${event.text.slice(0, 39)}…` : event.text)}`}`;
    case "upload":
      return `upload ${event.files.join(", ")}`;
    case "download":
      return event.failure === undefined
        ? `download ${event.name} (${event.size ?? 0} bytes)`
        : `download ${event.name} failed: ${event.failure}`;
  }
}

/** A file name without path separators or control characters. */
function safeFileName(name: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is removed
  return name.replace(/[/\\\u0000-\u001f]/g, "_").slice(0, 100) || "download";
}
