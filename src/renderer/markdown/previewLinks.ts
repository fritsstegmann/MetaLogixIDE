export type PreviewLinkAction = { kind: 'external'; url: string } | { kind: 'ignore' };

/** Decides what a click on a preview anchor does. Callers always preventDefault. */
export function resolvePreviewLink(href: string | null, insideDiagram: boolean): PreviewLinkAction {
  void href;
  void insideDiagram;
  throw new Error('not implemented');
}
