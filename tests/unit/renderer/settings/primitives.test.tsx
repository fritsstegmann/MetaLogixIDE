import { describe, it, expect, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  Field,
  Header,
  SettingRow,
  SettingStack,
  SettingsSection,
  Switch,
  WorkspaceNumber,
} from '@renderer/components/settings/primitives';

type Props = Record<string, unknown> & { children?: ReactNode };

function elements(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Props>(node)) return [];
  return [node, ...elements(node.props.children)];
}

function attr(html: string, tag: string, name: string): string | undefined {
  const open = new RegExp(`<${tag}\\b[^>]*>`).exec(html)?.[0] ?? '';
  return new RegExp(`\\s${name}="([^"]*)"`).exec(open)?.[1];
}

function classes(html: string, tag: string): string[] {
  return attr(html, tag, 'class')?.split(/\s+/) ?? [];
}

describe('Header and Field (used by frozen panels)', () => {
  it('Header markup is unchanged', () => {
    expect(renderToStaticMarkup(<Header title="T" subtitle="S" />)).toBe(
      '<div class="space-y-1"><div class="text-lg font-semibold">T</div><div class="text-sm text-[--text-muted]">S</div></div>',
    );
  });

  it('Field markup is unchanged with and without a hint', () => {
    expect(renderToStaticMarkup(<Field label="L" hint="H"><input /></Field>)).toBe(
      '<div class="space-y-2"><div class="text-sm font-medium">L</div><div class="text-xs text-[--text-muted]">H</div><input/></div>',
    );
    expect(renderToStaticMarkup(<Field label="L"><input /></Field>)).toBe(
      '<div class="space-y-2"><div class="text-sm font-medium">L</div><input/></div>',
    );
  });
});

describe('SettingsSection', () => {
  const html = renderToStaticMarkup(
    <SettingsSection title="Fonts" hint="Pick a font.">
      <p>child</p>
    </SettingsSection>,
  );

  it('is a section labelled by an h2 whose source text is the title as written', () => {
    expect(/<h2[^>]*>([^<]*)<\/h2>/.exec(html)?.[1]).toBe('Fonts');
    const id = attr(html, 'h2', 'id');
    expect(id).toBeTruthy();
    expect(attr(html, 'section', 'aria-labelledby')).toBe(id);
  });

  it('styles the heading as a muted uppercase eyebrow', () => {
    expect(classes(html, 'h2')).toEqual(expect.arrayContaining(['uppercase', 'text-[--text-muted]', 'font-semibold']));
  });

  it('renders the hint and the children', () => {
    expect(html).toContain('>Pick a font.<');
    expect(html).toContain('<p>child</p>');
  });

  it('omits the hint when none is given', () => {
    const bare = renderToStaticMarkup(<SettingsSection title="Workspace"><p>child</p></SettingsSection>);
    expect(bare.match(/<h2/g)).toHaveLength(1);
    expect(bare.match(/text-\[--text-muted\]/g)).toHaveLength(1);
  });
});

describe('SettingRow', () => {
  it('ties the label to the control with for= and shows the hint', () => {
    const html = renderToStaticMarkup(
      <SettingRow label="Keep-alive cap" hint="Shells kept running." htmlFor="ws-cap">
        <input id="ws-cap" />
      </SettingRow>,
    );
    expect(/<label[^>]*for="ws-cap"[^>]*>Keep-alive cap<\/label>/.test(html)).toBe(true);
    expect(html).toContain('>Shells kept running.<');
    expect(html).toContain('<input id="ws-cap"/>');
  });

  it('renders a plain text label when no control id is given', () => {
    const html = renderToStaticMarkup(<SettingRow label="Mode" hint="System follows macOS."><div /></SettingRow>);
    expect(html).not.toContain('<label');
    expect(html).toContain('>Mode<');
  });
});

describe('SettingStack', () => {
  it('is a group named by its visible label', () => {
    const html = renderToStaticMarkup(<SettingStack label="Theme"><button type="button">x</button></SettingStack>);
    const labelledby = attr(html, 'div', 'aria-labelledby');
    expect(attr(html, 'div', 'role')).toBe('group');
    expect(new RegExp(`id="${labelledby}"[^>]*>Theme<`).test(html)).toBe(true);
  });
});

describe('WorkspaceNumber', () => {
  const base = { id: 'ws-watch', value: 500, min: 50, max: 5000, step: 50 } as const;

  it('renders a right-aligned tabular number input with its id and range', () => {
    const html = renderToStaticMarkup(<WorkspaceNumber {...base} onChange={() => {}} />);
    expect(attr(html, 'input', 'type')).toBe('number');
    expect(attr(html, 'input', 'id')).toBe('ws-watch');
    expect([attr(html, 'input', 'min'), attr(html, 'input', 'max'), attr(html, 'input', 'step')]).toEqual(['50', '5000', '50']);
    expect(attr(html, 'input', 'value')).toBe('500');
    expect(classes(html, 'input')).toEqual(expect.arrayContaining(['text-right', 'tabular-nums']));
  });

  it('defaults step to 1 and renders an empty value before load', () => {
    const html = renderToStaticMarkup(<WorkspaceNumber id="ws-cap" value={null} min={1} max={20} onChange={() => {}} />);
    expect(attr(html, 'input', 'step')).toBe('1');
    expect(attr(html, 'input', 'value')).toBe('');
  });

  it.each([
    ['25', 20],
    ['0', 1],
    ['7', 7],
  ])('typing %s saves %d (clamped to 1..20)', (typed, saved) => {
    const onChange = vi.fn();
    const input = WorkspaceNumber({ id: 'ws-cap', value: 5, min: 1, max: 20, onChange });
    (input.props.onChange as (e: unknown) => void)({ target: { value: typed } });
    expect(onChange).toHaveBeenCalledWith(saved);
  });

  it('ignores non-numeric input', () => {
    const onChange = vi.fn();
    const input = WorkspaceNumber({ id: 'ws-cap', value: 5, min: 1, max: 20, onChange });
    (input.props.onChange as (e: unknown) => void)({ target: { value: 'abc' } });
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('Switch', () => {
  const props = {
    label: 'When Claude needs input',
    ariaLabel: 'Notify when Claude needs input',
    testId: 'notify-needs-input-toggle',
  };

  it('is a native checkbox with role switch, its test id and an accessible name containing the visible label', () => {
    const html = renderToStaticMarkup(<Switch {...props} checked onChange={() => {}} />);
    expect(attr(html, 'input', 'type')).toBe('checkbox');
    expect(attr(html, 'input', 'role')).toBe('switch');
    expect(attr(html, 'input', 'data-testid')).toBe('notify-needs-input-toggle');
    expect(attr(html, 'input', 'aria-label')?.toLowerCase()).toContain(props.label.toLowerCase());
    expect(html).toContain(`>${props.label}<`);
  });

  it('reflects the checked state', () => {
    expect(attr(renderToStaticMarkup(<Switch {...props} checked onChange={() => {}} />), 'input', 'checked')).toBe('');
    expect(attr(renderToStaticMarkup(<Switch {...props} checked={false} onChange={() => {}} />), 'input', 'checked')).toBeUndefined();
  });

  it('wraps the row in a label so clicking the text toggles it', () => {
    const html = renderToStaticMarkup(<Switch {...props} checked={false} onChange={() => {}} />);
    expect(html).toMatch(/^<label\b.*<input\b.*<\/label>$/);
  });

  it('keeps the checkbox full-size and clickable, only visually transparent', () => {
    const html = renderToStaticMarkup(<Switch {...props} checked={false} onChange={() => {}} />);
    const cls = classes(html, 'input');
    expect(cls).toEqual(expect.arrayContaining(['absolute', 'inset-0', 'opacity-0']));
    expect(cls).not.toEqual(expect.arrayContaining(['sr-only']));
    expect(cls.filter((c) => /^(w|h)-(px|0)$/.test(c))).toEqual([]);
  });

  it.each([true, false])('reports the new state %s on change', (next) => {
    const onChange = vi.fn();
    const input = elements(Switch({ ...props, checked: !next, onChange })).find((e) => e.type === 'input');
    (input?.props.onChange as (e: unknown) => void)({ target: { checked: next } });
    expect(onChange).toHaveBeenCalledWith(next);
  });
});
