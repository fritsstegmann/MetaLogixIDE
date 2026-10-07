import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { api } from '../api';
import type { MainTab } from '../main-tab';
import { createPendingShells, killAndForget, type PendingShell } from '../pending-kill';
import type { SplitPanes } from '../components/ShellSplit';
import { terminalFocus } from './useWindowTerminalFocus';

/** What the split lifecycle reads from App: the selected project, the main tab, the split's shells and their setters. */
export interface SplitLifecycleInput {
  selectedId: number | null;
  mainTab: MainTab;
  activeShellIndex: number;
  rightShellIndex: number | null;
  setRightShellIndex: (index: number | null) => void;
  setActiveShellIndexFor: (projectId: number, index: number) => void;
  isPopped: (projectId: number, shellIndex: number) => boolean;
}

type PaneActions = Pick<SplitPanes, 'onMoveToTab' | 'onClose' | 'onRightExited' | 'onExitsSettled'>;

/** What App wires: shells to keep out of the strip, close, To tab, and the right pane's actions for a project. */
export interface SplitLifecycle {
  hiddenShells: number[];
  closeSplit: (refocus?: boolean) => void;
  moveSplitToTab: () => void;
  paneActions: (projectId: number) => PaneActions;
}

/** The pending kill and activation sets, the kill itself, and the flush when the shell area unmounts. */
function usePendingSplitShells(selectedId: number | null, mainTab: MainTab) {
  const [kills] = useState(createPendingShells);
  const [activations] = useState(createPendingShells);
  const focusActivatedRef = useRef<number | null>(null);
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const kill = useCallback((shell: PendingShell) => {
    void killAndForget(kills, shell, (s) => api.invoke('shells:kill', s)).then(rerender);
  }, [kills]);
  // A split closed just before the shell area unmounts never reports its exit, so kill it now.
  useEffect(() => () => {
    for (const shell of kills.flushAll()) kill(shell);
    for (const shell of activations.flushAll()) activations.forget(shell.projectId, shell.shellIndex);
    focusActivatedRef.current = null;
  }, [selectedId, mainTab, kills, activations, kill]);
  return { kills, activations, kill, focusActivatedRef };
}

/**
 * The split's shell lifecycle beyond what ShellSplit renders. Close marks the right shell for a
 * kill once its fold-out finishes; "To tab" marks a non-popped shell for activation then. When a
 * right pane's exit completes its shell is killed or activated; when every exit has settled, any
 * shell still pending (a reopened pane that was queued and never mounted) is killed. A shell
 * pending its kill stays out of the tab strip until the kill settles. A shell activated by To tab
 * takes focus in an effect after the commit that made it the left pane, so the outgoing left
 * terminal (also primary) cannot consume the request. Leaving the project or the Shell tab
 * flushes: pending kills run at once, pending activations are dropped.
 */
export function useSplitLifecycle(input: SplitLifecycleInput): SplitLifecycle {
  const { selectedId, mainTab, activeShellIndex, rightShellIndex, setRightShellIndex, setActiveShellIndexFor, isPopped } = input;
  const { kills, activations, kill, focusActivatedRef } = usePendingSplitShells(selectedId, mainTab);
  useEffect(() => {
    const projectId = focusActivatedRef.current;
    focusActivatedRef.current = null;
    if (projectId != null && projectId === selectedId) terminalFocus.requestProjectFocus(projectId);
  }, [activeShellIndex, selectedId, focusActivatedRef]);

  function closeSplit(refocus = false) {
    if (selectedId == null || rightShellIndex == null) return;
    kills.mark(selectedId, rightShellIndex);
    setRightShellIndex(null);
    if (refocus) terminalFocus.requestProjectFocus(selectedId);
  }
  function moveSplitToTab() {
    if (selectedId == null || rightShellIndex == null) return;
    if (!isPopped(selectedId, rightShellIndex)) activations.mark(selectedId, rightShellIndex);
    setRightShellIndex(null);
    terminalFocus.requestProjectFocus(selectedId);
  }
  function onRightExited(projectId: number, shellIndex: number) {
    if (kills.takeIfPending(projectId, shellIndex)) kill({ projectId, shellIndex });
    if (!activations.takeIfPending(projectId, shellIndex)) return;
    activations.forget(projectId, shellIndex);
    focusActivatedRef.current = projectId;
    setActiveShellIndexFor(projectId, shellIndex);
  }

  return {
    hiddenShells: selectedId == null ? [] : kills.hidden(selectedId),
    closeSplit,
    moveSplitToTab,
    paneActions: (projectId) => ({
      onMoveToTab: moveSplitToTab,
      onClose: () => closeSplit(true),
      onRightExited: (index) => onRightExited(projectId, index),
      onExitsSettled: () => { for (const shell of kills.takeAll(projectId)) kill(shell); },
    }),
  };
}
