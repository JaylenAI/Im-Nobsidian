import { ConversionPipeline } from "./pipeline.js";
import { FrontmatterExtractor } from "./pre-processors/frontmatter.js";
import { WikilinkResolver } from "./pre-processors/wikilink.js";
import { CalloutTransformer } from "./pre-processors/callout.js";
import { MathNormalizer } from "./pre-processors/math.js";
import { EmbedResolver } from "./pre-processors/embed.js";
import { PreserveMarkerCollector } from "./pre-processors/preserve-marker.js";
import { UnsupportedBlockStripper } from "./pre-processors/unsupported-block-stripper.js";
import { PropertiesTableInjector } from "./pre-processors/properties-table.js";
import { HtmlAnnotationStripper } from "./pre-processors/html-annotation.js";
import { MentionToWikilink } from "./post-processors/mention-to-wikilink.js";
import { PreserveMarkerInjector } from "./post-processors/preserve-marker-injector.js";
import { CalloutRestorer } from "./post-processors/callout-restorer.js";
import { ColorAnnotator } from "./post-processors/color-annotator.js";
import { FrontmatterGenerator } from "./post-processors/frontmatter-generator.js";
import { LocalImageRestorer } from "./post-processors/local-image-restorer.js";
import { PropertiesTableRestorer } from "./post-processors/properties-table-restorer.js";

export function createDefaultPipeline(): ConversionPipeline {
  const pipeline = new ConversionPipeline();

  pipeline.registerPreProcessor(new HtmlAnnotationStripper());
  pipeline.registerPreProcessor(new UnsupportedBlockStripper());
  pipeline.registerPreProcessor(new FrontmatterExtractor());
  pipeline.registerPreProcessor(new PropertiesTableInjector());
  pipeline.registerPreProcessor(new WikilinkResolver());
  pipeline.registerPreProcessor(new CalloutTransformer());
  pipeline.registerPreProcessor(new MathNormalizer());
  pipeline.registerPreProcessor(new EmbedResolver());
  pipeline.registerPreProcessor(new PreserveMarkerCollector());

  pipeline.registerPostProcessor(new PropertiesTableRestorer());
  pipeline.registerPostProcessor(new LocalImageRestorer());
  pipeline.registerPostProcessor(new PreserveMarkerInjector());
  pipeline.registerPostProcessor(new MentionToWikilink());
  pipeline.registerPostProcessor(new CalloutRestorer());
  pipeline.registerPostProcessor(new ColorAnnotator());
  pipeline.registerPostProcessor(new FrontmatterGenerator());

  return pipeline;
}
