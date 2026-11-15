import type { AudioController } from "../audio/AudioController";
import { LATEST_NOTICE_ID, NOTICES } from "../notices";
import { persistSave } from "../storage";
import type { GameSave, NoticeCategory, NoticeEntry } from "../types";
import { byId } from "./dom";
import type { Overlays } from "./Overlays";

export interface NoticeModalDeps {
  save: GameSave;
  audio: AudioController;
  overlays: Overlays;
  canOpen: () => boolean;
}

export class NoticeModal {
  private readonly noticeBtn = byId<HTMLButtonElement>("noticeBtn");
  private readonly noticeDot = byId("noticeDot");
  private readonly noticeVersion = byId("noticeVersion");
  private readonly noticeList = byId("noticeList");
  private readonly noticeTabUpdate = byId<HTMLButtonElement>("noticeTabUpdate");
  private readonly noticeTabBulletin = byId<HTMLButtonElement>("noticeTabBulletin");
  private readonly noticeOkBtn = byId<HTMLButtonElement>("noticeOkBtn");
  private readonly noticeCloseBtn = byId<HTMLButtonElement>("noticeCloseBtn");

  private readonly deps: NoticeModalDeps;
  private category: NoticeCategory = "update";

  constructor(deps: NoticeModalDeps) {
    this.deps = deps;

    const handleTabKey = (event: KeyboardEvent): void => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      this.switchTab(this.category === "update" ? "bulletin" : "update", true);
    };

    this.noticeBtn.addEventListener("click", () => this.open());
    this.noticeTabUpdate.addEventListener("click", () => this.switchTab("update"));
    this.noticeTabBulletin.addEventListener("click", () => this.switchTab("bulletin"));
    this.noticeTabUpdate.addEventListener("keydown", handleTabKey);
    this.noticeTabBulletin.addEventListener("keydown", handleTabKey);
    this.noticeOkBtn.addEventListener("click", () => this.deps.overlays.hideNotice());
    this.noticeCloseBtn.addEventListener("click", () => this.deps.overlays.hideNotice());
    this.deps.overlays.notice.addEventListener("click", (event) => {
      if (event.target === this.deps.overlays.notice) {
        this.deps.overlays.hideNotice();
      }
    });
  }

  updateBadge(): void {
    const unread = this.deps.save.lastSeenNoticeId !== LATEST_NOTICE_ID;
    this.noticeDot.hidden = !unread;
    this.noticeBtn.classList.toggle("has-unread", unread);
    this.noticeBtn.setAttribute(
      "aria-label",
      unread ? "山脊公报（有未读更新）" : "山脊公报",
    );
    const latestVersioned = NOTICES.find((entry) => entry.version);
    if (latestVersioned?.version) {
      this.noticeVersion.textContent = latestVersioned.version.replace(/\.0$/, "");
    }
  }

  open(initialTab?: NoticeCategory): void {
    if (!this.deps.canOpen()) return;
    const { save, audio, overlays } = this.deps;
    audio.ensure();
    const unread = save.lastSeenNoticeId !== LATEST_NOTICE_ID;
    const targetTab =
      initialTab ?? (unread ? (NOTICES[0]?.category ?? "update") : this.category);
    this.setTab(targetTab);
    save.lastSeenNoticeId = LATEST_NOTICE_ID;
    persistSave(save, true);
    this.updateBadge();
    audio.select();
    overlays.showNotice(this.noticeOkBtn);
  }

  private switchTab(category: NoticeCategory, focusTab = false): void {
    if (category === this.category) {
      if (focusTab) {
        (category === "update" ? this.noticeTabUpdate : this.noticeTabBulletin).focus();
      }
      return;
    }
    this.deps.audio.ensure();
    this.deps.audio.select();
    this.setTab(category, focusTab);
  }

  private setTab(category: NoticeCategory, focusTab = false): void {
    this.category = category;
    const isUpdate = category === "update";
    this.noticeTabUpdate.classList.toggle("is-active", isUpdate);
    this.noticeTabBulletin.classList.toggle("is-active", !isUpdate);
    this.noticeTabUpdate.setAttribute("aria-selected", String(isUpdate));
    this.noticeTabBulletin.setAttribute("aria-selected", String(!isUpdate));
    this.noticeList.setAttribute(
      "aria-labelledby",
      isUpdate ? "noticeTabUpdate" : "noticeTabBulletin",
    );
    this.renderList(category);
    this.noticeList.scrollTop = 0;
    if (focusTab) {
      (isUpdate ? this.noticeTabUpdate : this.noticeTabBulletin).focus();
    }
  }

  private renderList(category: NoticeCategory): void {
    const entries: NoticeEntry[] = [
      ...NOTICES.filter((entry) => entry.category === category && entry.pinned),
      ...NOTICES.filter((entry) => entry.category === category && !entry.pinned),
    ];
    this.noticeList.replaceChildren();
    if (entries.length === 0) {
      const empty = document.createElement("p");
      empty.className = "notice-empty";
      empty.textContent = "这一栏还没有新的公报。";
      this.noticeList.appendChild(empty);
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const entry of entries) fragment.appendChild(this.createCard(entry));
    this.noticeList.appendChild(fragment);
  }

  private createCard(entry: NoticeEntry): HTMLElement {
    const card = document.createElement("article");
    card.className = "notice-card";
    card.dataset.noticeId = entry.id;
    if (entry.pinned) card.classList.add("is-pinned");

    const head = document.createElement("header");
    head.className = "notice-card-head";

    const titleWrap = document.createElement("div");
    titleWrap.className = "notice-card-title";
    if (entry.pinned) {
      const pin = document.createElement("span");
      pin.className = "notice-pin";
      pin.textContent = "PINNED";
      titleWrap.appendChild(pin);
    }
    const title = document.createElement("h3");
    title.textContent = entry.title;
    titleWrap.appendChild(title);
    head.appendChild(titleWrap);

    if (entry.version) {
      const version = document.createElement("span");
      version.className = "notice-version";
      version.textContent = entry.version;
      head.appendChild(version);
    }
    card.appendChild(head);

    const date = document.createElement("p");
    date.className = "notice-date";
    date.textContent = entry.date;
    card.appendChild(date);

    const summary = document.createElement("p");
    summary.className = "notice-summary";
    summary.textContent = entry.summary;
    card.appendChild(summary);

    const items = document.createElement("ul");
    items.className = "notice-items";
    for (const item of entry.items) {
      const row = document.createElement("li");
      row.className = "notice-item";

      const tag = document.createElement("span");
      tag.className = "notice-tag";
      tag.dataset.tone = item.tone;
      tag.textContent = item.tag;

      const text = document.createElement("span");
      text.className = "notice-item-text";
      text.textContent = item.text;

      row.append(tag, text);
      items.appendChild(row);
    }
    card.appendChild(items);

    return card;
  }
}
