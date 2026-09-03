/**
 * Render an RFC body.
 *
 * WHY THIS IS NOT AN XSS HOLE, AND WHAT WOULD MAKE IT ONE
 * -------------------------------------------------------
 * RFC bodies are written by colleagues and read by colleagues, which is exactly the
 * shape of an internal stored-XSS problem: the text goes into DynamoDB from one
 * signed-in person and comes back out onto another signed-in person's screen, with
 * their token in the tab.
 *
 * react-markdown does not have that problem, because it does not use
 * dangerouslySetInnerHTML at all. It parses to an AST and builds React elements, so
 * a `<script>` in the source is text in the output rather than markup. Raw HTML in
 * the source is IGNORED, not escaped-and-rendered.
 *
 * That safety is a property of the plugin list, not of the library, and there is
 * exactly one way to lose it: adding `rehype-raw`, which exists to re-enable raw
 * HTML and would hand every reader's session to whoever writes the next RFC. Do not
 * add it. If embedded HTML is ever genuinely needed, it needs `rehype-sanitize`
 * alongside it and a conversation about what the allowlist is.
 *
 * remark-gfm is a different kind of plugin and is safe: tables, strikethrough, task
 * lists and autolinks, all of which stay inside the AST.
 *
 * WHY A COMPONENT AND NOT A ONE-LINER AT EACH CALL SITE
 * -----------------------------------------------------
 * Two reasons, and the first is the security one above: the plugin list is a
 * decision, and it should exist in one file where the comment explaining it is
 * attached to it. Scattered `<ReactMarkdown>` calls are four chances to add a plugin
 * without reading this.
 *
 * The second is that markdown output is unstyled by default. The GlobalStyle reset
 * strips heading margins app-wide, which is right for the chart and wrong for prose,
 * so the container below puts them back for this subtree only.
 */

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import styled from 'styled-components';

import { monoStack, palette, radius } from '../styles/theme';

/*
  Prose styling, scoped to rendered markdown and nowhere else.

  `overflow-wrap: anywhere` on the root is doing real work: an RFC quoting a long URL
  or an ARN would otherwise widen the container past the viewport and give the whole
  page a horizontal scrollbar, which on this app also drags the roadmap's timeline
  out of alignment on the next tab.
*/
const Prose = styled.div`
  color: ${palette.ink};
  font-size: 14px;
  line-height: 1.65;
  overflow-wrap: anywhere;

  /* The reset zeroes these globally for the chart's sake. Prose needs them back. */
  h1,
  h2,
  h3,
  h4 {
    margin: 1.4em 0 0.5em;
    line-height: 1.25;
    color: ${palette.deepMagenta};
  }

  /*
    The whole scale sits BELOW the 20px the page gives the RFC's own title, which is
    why h1 is 18px and not the 22px it would be on its own. Almost every RFC opens
    with a top-level "Context" heading, and at 22px that heading was drawn larger
    than the name
    of the document containing it - the page then reads as though "Context" is the
    title and "How we do code review" is a label above it.
  */
  h1 {
    font-size: 18px;
  }
  h2 {
    font-size: 16px;
  }
  h3 {
    font-size: 14px;
  }
  h4 {
    font-size: 13px;
  }

  /* No top margin on the first block, or every RFC opens with a gap the author did
     not write and cannot remove. */
  > *:first-child {
    margin-top: 0;
  }

  p,
  ul,
  ol,
  blockquote,
  table,
  pre {
    margin: 0 0 1em;
  }

  ul,
  ol {
    padding-left: 1.4em;
  }

  li {
    margin: 0.25em 0;
  }

  /* GFM task lists. The checkboxes are disabled by react-markdown, which is correct:
     they reflect the text, and a click that appeared to work but saved nothing would
     be worse than one that does not respond.

     The classes are remark-gfm's own, not ours, and the indent is undone rather than
     merely hidden: dropping the marker alone leaves the row indented by the width of
     a bullet that is no longer drawn, so a checklist sits further right than the
     prose around it for no visible reason. */
  .contains-task-list {
    list-style: none;
    padding-left: 0;
  }

  .task-list-item input[type='checkbox'] {
    margin-right: 0.5em;
  }

  a {
    color: ${palette.hotPink};
    text-decoration: underline;

    &:hover {
      color: ${palette.deepMagenta};
    }
  }

  code {
    font-family: ${monoStack};
    font-size: 0.9em;
    background: ${palette.blush};
    border: 1px solid ${palette.border};
    border-radius: ${radius.sm};
    padding: 1px 5px;
  }

  pre {
    background: ${palette.blush};
    border: 1px solid ${palette.border};
    border-radius: ${radius.md};
    padding: 12px 14px;
    overflow-x: auto;

    /* The block already has the border and the padding; the span inside must not
       draw a second box around every line. */
    code {
      background: none;
      border: 0;
      padding: 0;
    }
  }

  blockquote {
    border-left: 3px solid ${palette.borderStrong};
    margin-left: 0;
    padding: 2px 0 2px 14px;
    color: ${palette.inkSoft};
  }

  table {
    border-collapse: collapse;
    width: 100%;
    font-size: 13px;
  }

  th,
  td {
    border: 1px solid ${palette.border};
    padding: 6px 10px;
    text-align: left;
  }

  th {
    background: ${palette.blush};
    color: ${palette.deepMagenta};
  }

  hr {
    border: 0;
    border-top: 1px solid ${palette.border};
    margin: 1.6em 0;
  }

  img {
    max-width: 100%;
  }
`;

const Empty = styled.p`
  margin: 0;
  color: ${palette.inkSoft};
  font-size: 13px;
`;

export default function Markdown({ children }: { children: string }) {
  if (!children.trim()) {
    /*
      An RFC with a title and no body yet is a normal first draft, not an error.
      Saying so beats rendering nothing, which looks like a failed load.
    */
    return <Empty>Nothing written yet.</Empty>;
  }

  return (
    <Prose>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          /*
            Links out of the app open in a new tab, and `rel` is not optional
            decoration: without noopener the opened page gets a handle on this one
            through window.opener and can navigate it somewhere else. Modern browsers
            imply it for target=_blank, older ones do not, and this costs nothing.
          */
          a: ({ href, children: text }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {text}
            </a>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </Prose>
  );
}
