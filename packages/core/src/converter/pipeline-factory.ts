import { ConversionPipeline } from "./pipeline.js";
import { FrontmatterExtractor } from "./pre-processors/frontmatter.js";
import { WikilinkResolver, type WikilinkResolverFn } from "./pre-processors/wikilink.js";
import { CalloutTransformer } from "./pre-processors/callout.js";
import { MathNormalizer } from "./pre-processors/math.js";
import { EmbedResolver } from "./pre-processors/embed.js";
import { PreserveMarkerCollector } from "./pre-processors/preserve-marker.js";
import { UnsupportedBlockStripper } from "./pre-processors/unsupported-block-stripper.js";
import { PropertiesTableInjector } from "./pre-processors/properties-table.js";
import { InlineAnnotationPreserver } from "./pre-processors/html-annotation.js";
import { CommentStripper } from "./pre-processors/comment-stripper.js";
import { FootnoteGuard } from "./pre-processors/footnote-guard.js";
import { TableAlignmentGuard } from "./pre-processors/table-alignment.js";
import { MentionToWikilink } from "./post-processors/mention-to-wikilink.js";
import { EscapeNormalizer } from "./post-processors/escape-normalizer.js";
import { HighlightRestorer } from "./post-processors/highlight-restorer.js";
import { TableAlignmentRestorer } from "./post-processors/table-alignment-restorer.js";
import { PreserveMarkerInjector } from "./post-processors/preserve-marker-injector.js";
import { CalloutRestorer } from "./post-processors/callout-restorer.js";
import { ColorAnnotator } from "./post-processors/color-annotator.js";
import { FrontmatterGenerator } from "./post-processors/frontmatter-generator.js";
import { LocalImageRestorer } from "./post-processors/local-image-restorer.js";
import { PropertiesTableRestorer } from "./post-processors/properties-table-restorer.js";
import { BlockSpacer } from "./post-processors/block-spacer.js";

export interface PipelineOptions {
  readonly wikilinkResolver?: WikilinkResolverFn;
}

export function createDefaultPipeline(options?: PipelineOptions): ConversionPipeline {
  const pipeline = new ConversionPipeline();

  pipeline.registerPreProcessor(new InlineAnnotationPreserver());
  pipeline.registerPreProcessor(new UnsupportedBlockStripper());
  pipeline.registerPreProcessor(new CommentStripper());
  pipeline.registerPreProcessor(new FrontmatterExtractor());
  pipeline.registerPreProcessor(new FootnoteGuard());
  pipeline.registerPreProcessor(new PropertiesTableInjector());
  pipeline.registerPreProcessor(new WikilinkResolver(options?.wikilinkResolver));
  pipeline.registerPreProcessor(new CalloutTransformer());
  pipeline.registerPreProcessor(new TableAlignmentGuard());
  pipeline.registerPreProcessor(new MathNormalizer());
  pipeline.registerPreProcessor(new EmbedResolver());
  pipeline.registerPreProcessor(new PreserveMarkerCollector());

  pipeline.registerPostProcessor(new EscapeNormalizer());
  pipeline.registerPostProcessor(new PropertiesTableRestorer());
  pipeline.registerPostProcessor(new LocalImageRestorer());
  pipeline.registerPostProcessor(new HighlightRestorer());
  pipeline.registerPostProcessor(new TableAlignmentRestorer());
  pipeline.registerPostProcessor(new PreserveMarkerInjector());
  pipeline.registerPostProcessor(new MentionToWikilink());
  pipeline.registerPostProcessor(new CalloutRestorer());
  pipeline.registerPostProcessor(new ColorAnnotator());
  pipeline.registerPostProcessor(new FrontmatterGenerator());
  pipeline.registerPostProcessor(new BlockSpacer());

  return pipeline;
}
