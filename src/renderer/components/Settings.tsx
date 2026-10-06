import { useCallback, useEffect, useRef, useState } from 'react';
import type { FontDiscoveryState } from '@renderer/components/FontControl';
import { discoverLocalFonts } from '@renderer/fonts/local-font-access';
import { GeneralPanel } from '@renderer/components/settings/GeneralPanel';
import { RootsPanel } from '@renderer/components/settings/RootsPanel';
import { LaunchPanel } from '@renderer/components/settings/LaunchPanel';
import { MetaprojectPanel } from '@renderer/components/settings/MetaprojectPanel';
type Section = 'general' | 'roots' | 'launch' | 'metaproject';

/** Renders application settings and owns installed-font discovery for one open session. */
export function Settings({ open, onClose }: { open: boolean; onClose: () => void }): React.JSX.Element | null {
  const [section, setSection] = useState<Section>('general');
  const [fontDiscovery, setFontDiscovery] = useState<FontDiscoveryState>({ status: 'idle' });
  const fontDiscoveryAttempted = useRef(false);
  const fontDiscoveryGeneration = useRef(0);

  useEffect(() => {
    if (open) return;
    fontDiscoveryGeneration.current += 1;
    fontDiscoveryAttempted.current = false;
    setFontDiscovery({ status: 'idle' });
  }, [open]);

  const loadInstalledFonts = useCallback(async (): Promise<void> => {
    if (fontDiscoveryAttempted.current) return;
    fontDiscoveryAttempted.current = true;
    const generation = fontDiscoveryGeneration.current;
    setFontDiscovery({ status: 'loading' });
    const result = await discoverLocalFonts(window);
    if (fontDiscoveryGeneration.current === generation) {
      fontDiscoveryAttempted.current = false;
      setFontDiscovery(result);
    }
  }, []);

  if (!open) return null;
  return (
    <div
      className="modal-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onClose}
      data-testid="settings-modal"
    >
      <div
        className="modal-panel relative flex h-[600px] max-h-[92vh] w-[760px] max-w-[92vw] flex-col overflow-hidden rounded-2xl bg-[--panel-strong] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="drag h-12 flex items-center justify-between pl-5 pr-2 shrink-0">
          <span className="text-sm font-semibold">Settings</span>
          <button
            type="button"
            onClick={onClose}
            className="no-drag flex min-h-11 min-w-11 items-center justify-center rounded-md text-[--text-muted] hover:bg-[--surface-hover] hover:text-[--text]"
            title="Close (Esc)"
            data-testid="settings-close"
            aria-label="Close settings"
          >
            <CloseIcon />
          </button>
        </div>

        {/* Body: nav + panel */}
        <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
          <nav aria-label="Settings sections" className="flex w-full shrink-0 gap-2 overflow-x-auto px-3 pb-3 sm:w-48 sm:flex-col sm:gap-1 sm:overflow-visible sm:pt-1">
            <SectionButton active={section === 'general'} onClick={() => setSection('general')}>General</SectionButton>
            <SectionButton active={section === 'roots'} onClick={() => setSection('roots')}>Root directories</SectionButton>
            <SectionButton active={section === 'launch'} onClick={() => setSection('launch')}>Launch commands</SectionButton>
            <SectionButton active={section === 'metaproject'} onClick={() => setSection('metaproject')}>Metaproject</SectionButton>
            <div className="mt-auto hidden px-2 pt-3 text-[10px] text-[--text-muted] sm:block">
              MetaLogix IDE · Phase 1
            </div>
          </nav>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6 sm:px-6 sm:pt-1">
            {section === 'general' && (
              <GeneralPanel
                fontDiscovery={fontDiscovery}
                onLoadInstalledFonts={loadInstalledFonts}
              />
            )}
            {section === 'roots' && <RootsPanel />}
            {section === 'launch' && <LaunchPanel />}
            {section === 'metaproject' && <MetaprojectPanel />}
          </div>
        </div>

        {/* Footer */}
        <div className="h-14 flex items-center justify-end gap-2 px-4 shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="pressable min-h-10 rounded-lg bg-[--accent-soft] px-5 text-sm font-medium text-[--accent-soft-text] hover:brightness-125"
            data-testid="settings-done"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

function CloseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function SectionButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`min-h-10 shrink-0 rounded-lg px-3 py-2 text-left text-sm sm:w-full sm:px-2.5 ${
        active ? 'bg-[--accent-soft] text-[--accent-soft-text] font-medium' : 'hover:bg-[--surface-hover] text-[--text-muted] hover:text-[--text]'
      }`}
    >
      {children}
    </button>
  );
}
