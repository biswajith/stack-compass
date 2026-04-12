import { assert } from '../helpers.js';
import { parseMarkdownSections, toDocSections, buildSectionMap } from '../../src/tree-builder.js';

export function testTreeBuilder() {
  console.log('\n── Unit: tree-builder ──────────────────────────────');

  const md = `# Main Title

Intro paragraph.

## Getting Started

How to get started with the framework.

### Installation

Run npm install to get going.

### Configuration

Edit config.yml to configure.

## API Reference

Full API documentation.

### Core Methods

The main methods you need.

## FAQ

Common questions.`;

  const sections = parseMarkdownSections(md);

  assert('Parses single root section', sections.length === 1, `got ${sections.length}`);
  assert('Root is Main Title', sections[0].title === 'Main Title', sections[0].title);
  assert('Root has 3 h2 children', sections[0].children.length === 3, `got ${sections[0].children.length}`);

  const gettingStarted = sections[0].children[0];
  assert('Getting Started has 2 h3 children', gettingStarted.children.length === 2, `got ${gettingStarted.children.length}`);

  const apiRef = sections[0].children[1];
  assert('API Reference has 1 h3 child', apiRef.children.length === 1, `got ${apiRef.children.length}`);

  const faq = sections[0].children[2];
  assert('FAQ has 0 children', faq.children.length === 0, `got ${faq.children.length}`);

  // DocSection conversion
  const docSections = toDocSections(sections);
  assert('DocSections root has id', docSections[0].id === 'main-title', docSections[0].id);

  const gsDoc = docSections[0].children![0];
  assert('Getting Started DocSection has id', gsDoc.id === 'getting-started', gsDoc.id);
  assert('DocSections have summaries', gsDoc.summary.length > 0, 'empty summary');
  assert('Children are nested', gsDoc.children!.length === 2, `got ${gsDoc.children?.length}`);

  // Section map
  const sectionMap = buildSectionMap(sections);
  assert('Section map has all sections', sectionMap.size === 7, `got ${sectionMap.size}`);
  assert('Section map includes nested', sectionMap.has('installation'), 'missing installation');
  assert('Content includes heading', sectionMap.get('installation')!.includes('### Installation'), 'bad content');

  // Edge case: flat headings (no h1 root)
  const flat = `## Section A\nContent A\n\n## Section B\nContent B`;
  const flatSections = parseMarkdownSections(flat);
  assert('Flat headings parse correctly', flatSections.length === 2, `got ${flatSections.length}`);

  // Edge case: empty input — parser creates a synthetic "Overview" root
  const empty = parseMarkdownSections('');
  assert('Empty input returns synthetic root', empty.length === 1 && empty[0].title === 'Overview',
    `got ${empty.length} sections: ${empty.map(s => s.title).join(', ')}`);

  // Edge case: AsciiDoc headings
  const adoc = `= AsciiDoc Title\nIntro\n\n== Section One\nContent one\n\n== Section Two\nContent two`;
  const adocSections = parseMarkdownSections(adoc);
  assert('AsciiDoc headings parsed', adocSections.length >= 1, `got ${adocSections.length}`);
}
