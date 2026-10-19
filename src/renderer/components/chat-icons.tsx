import { ICON_SIZE, ICON_STROKE } from './icon-size';

/** Icons used by `ChatTab`: the link-plug banner, sign-in bubble and close, message hover actions, the attachment file/download/folder marks, and the empty-channel glyph. */
export function LinkPlugIcon() {
  return (
    <svg width={ICON_SIZE.md} height={ICON_SIZE.md} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={ICON_STROKE.outline} strokeLinecap="round" strokeLinejoin="round" className="text-[color:var(--accent)]">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  );
}

export function ChatBubbleIcon() {
  return (
    <svg width={ICON_SIZE.xl} height={ICON_SIZE.xl} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={ICON_STROKE.outline} strokeLinecap="round" strokeLinejoin="round" className="text-[color:var(--accent)]">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

export function CloseIcon() {
  return (
    <svg width={ICON_SIZE.md} height={ICON_SIZE.md} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={ICON_STROKE.outline} strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

export function EmptyChannelIcon() {
  return (
    <svg width={ICON_SIZE.xl} height={ICON_SIZE.xl} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={ICON_STROKE.outline} strokeLinecap="round" strokeLinejoin="round" className="opacity-60">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

export function EditIcon() {
  return (
    <svg width={ICON_SIZE.sm} height={ICON_SIZE.sm} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={ICON_STROKE.outline} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4z" />
    </svg>
  );
}

export function DeleteIcon() {
  return (
    <svg width={ICON_SIZE.sm} height={ICON_SIZE.sm} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={ICON_STROKE.outline} strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
      <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

export function FileIcon() {
  return (
    <svg width={ICON_SIZE.md} height={ICON_SIZE.md} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={ICON_STROKE.outline} strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

export function DownloadIcon() {
  return (
    <svg width={ICON_SIZE.sm} height={ICON_SIZE.sm} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={ICON_STROKE.outline} strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

export function FolderOpenIcon() {
  return (
    <svg width={ICON_SIZE.sm} height={ICON_SIZE.sm} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={ICON_STROKE.outline} strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 14l1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2" />
    </svg>
  );
}
