/// <reference types="chrome" />

/**
 * The extension APIs, typed by `@types/chrome`. The reference above brings in the `chrome` global:
 * the repo's tsconfig loads no `@types` package by default.
 */
export type Tab = chrome.tabs.Tab;
export type MessageSender = chrome.runtime.MessageSender;
export type ContextMenuInfo = chrome.contextMenus.OnClickData;
export type DnrRule = chrome.declarativeNetRequest.Rule;

export const ext: typeof chrome = chrome;
