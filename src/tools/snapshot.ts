import zodToJsonSchema from "zod-to-json-schema";

import {
  ClickTool,
  ClickByTextTool,
  DragTool,
  FindElementTool,
  HoverTool,
  PageSnapshotTool,
  ProductCardsTool,
  SelectOptionTool,
  SelectOptionByLabelTool,
  SetInputByLabelTool,
  SnapshotTool,
  TypeTool,
} from "@/tool-schemas";

import type { Context } from "@/context";
import { captureAriaSnapshot } from "@/utils/aria-snapshot";

import type { Tool } from "./tool";

export const snapshot: Tool = {
  schema: {
    name: SnapshotTool.shape.name.value,
    description: SnapshotTool.shape.description.value,
    inputSchema: zodToJsonSchema(SnapshotTool.shape.arguments),
  },
  handle: async (context: Context) => {
    return await captureAriaSnapshot(context);
  },
};

export const pageSnapshot: Tool = {
  schema: {
    name: PageSnapshotTool.shape.name.value,
    description: PageSnapshotTool.shape.description.value,
    inputSchema: zodToJsonSchema(PageSnapshotTool.shape.arguments),
  },
  handle: async (context: Context) => {
    const page = await context.sendSocketMessage(
      "browser_page_snapshot",
      {},
    );
    const screenshot = await context.sendSocketMessage<string>(
      "browser_screenshot",
      {},
    );
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(page, null, 2),
        },
        {
          type: "image",
          data: screenshot,
          mimeType: "image/png",
        },
      ],
    };
  },
};

export const productCards: Tool = {
  schema: {
    name: ProductCardsTool.shape.name.value,
    description: ProductCardsTool.shape.description.value,
    inputSchema: zodToJsonSchema(ProductCardsTool.shape.arguments),
  },
  handle: async (context: Context, params) => {
    const validatedParams = ProductCardsTool.shape.arguments.parse(params ?? {});
    const cards = await context.sendSocketMessage(
      "browser_extract_product_cards",
      validatedParams,
    );
    return {
      content: [{ type: "text", text: JSON.stringify(cards, null, 2) }],
    };
  },
};

export const findElement: Tool = {
  schema: {
    name: FindElementTool.shape.name.value,
    description: FindElementTool.shape.description.value,
    inputSchema: zodToJsonSchema(FindElementTool.shape.arguments),
  },
  handle: async (context: Context, params) => {
    const validatedParams = FindElementTool.shape.arguments.parse(params ?? {});
    const matches = await context.sendSocketMessage(
      "browser_find_element",
      validatedParams,
    );
    return {
      content: [{ type: "text", text: JSON.stringify(matches, null, 2) }],
    };
  },
};

export const click: Tool = {
  schema: {
    name: ClickTool.shape.name.value,
    description: ClickTool.shape.description.value,
    inputSchema: zodToJsonSchema(ClickTool.shape.arguments),
  },
  handle: async (context: Context, params) => {
    const validatedParams = ClickTool.shape.arguments.parse(params);
    await context.sendSocketMessage("browser_click", validatedParams);
    const snapshot = await captureAriaSnapshot(context);
    return {
      content: [
        {
          type: "text",
          text: `Clicked "${validatedParams.element}"`,
        },
        ...snapshot.content,
      ],
    };
  },
};

export const drag: Tool = {
  schema: {
    name: DragTool.shape.name.value,
    description: DragTool.shape.description.value,
    inputSchema: zodToJsonSchema(DragTool.shape.arguments),
  },
  handle: async (context: Context, params) => {
    const validatedParams = DragTool.shape.arguments.parse(params);
    await context.sendSocketMessage("browser_drag", validatedParams);
    const snapshot = await captureAriaSnapshot(context);
    return {
      content: [
        {
          type: "text",
          text: `Dragged "${validatedParams.startElement}" to "${validatedParams.endElement}"`,
        },
        ...snapshot.content,
      ],
    };
  },
};

export const hover: Tool = {
  schema: {
    name: HoverTool.shape.name.value,
    description: HoverTool.shape.description.value,
    inputSchema: zodToJsonSchema(HoverTool.shape.arguments),
  },
  handle: async (context: Context, params) => {
    const validatedParams = HoverTool.shape.arguments.parse(params);
    await context.sendSocketMessage("browser_hover", validatedParams);
    const snapshot = await captureAriaSnapshot(context);
    return {
      content: [
        {
          type: "text",
          text: `Hovered over "${validatedParams.element}"`,
        },
        ...snapshot.content,
      ],
    };
  },
};

export const type: Tool = {
  schema: {
    name: TypeTool.shape.name.value,
    description: TypeTool.shape.description.value,
    inputSchema: zodToJsonSchema(TypeTool.shape.arguments),
  },
  handle: async (context: Context, params) => {
    const validatedParams = TypeTool.shape.arguments.parse(params);
    await context.sendSocketMessage("browser_type", validatedParams);
    const snapshot = await captureAriaSnapshot(context);
    return {
      content: [
        {
          type: "text",
          text: `Typed "${validatedParams.text}" into "${validatedParams.element}"`,
        },
        ...snapshot.content,
      ],
    };
  },
};

export const selectOption: Tool = {
  schema: {
    name: SelectOptionTool.shape.name.value,
    description: SelectOptionTool.shape.description.value,
    inputSchema: zodToJsonSchema(SelectOptionTool.shape.arguments),
  },
  handle: async (context: Context, params) => {
    const validatedParams = SelectOptionTool.shape.arguments.parse(params);
    await context.sendSocketMessage("browser_select_option", validatedParams);
    const snapshot = await captureAriaSnapshot(context);
    return {
      content: [
        {
          type: "text",
          text: `Selected option in "${validatedParams.element}"`,
        },
        ...snapshot.content,
      ],
    };
  },
};

export const setInputByLabel: Tool = {
  schema: {
    name: SetInputByLabelTool.shape.name.value,
    description: SetInputByLabelTool.shape.description.value,
    inputSchema: zodToJsonSchema(SetInputByLabelTool.shape.arguments),
  },
  handle: async (context: Context, params) => {
    const validatedParams = SetInputByLabelTool.shape.arguments.parse(params);
    await context.sendSocketMessage("browser_set_input_by_label", validatedParams);
    const snapshot = await captureAriaSnapshot(context);
    return {
      content: [
        {
          type: "text",
          text: `Set input labeled "${validatedParams.label}"`,
        },
        ...snapshot.content,
      ],
    };
  },
};

export const selectOptionByLabel: Tool = {
  schema: {
    name: SelectOptionByLabelTool.shape.name.value,
    description: SelectOptionByLabelTool.shape.description.value,
    inputSchema: zodToJsonSchema(SelectOptionByLabelTool.shape.arguments),
  },
  handle: async (context: Context, params) => {
    const validatedParams = SelectOptionByLabelTool.shape.arguments.parse(params);
    await context.sendSocketMessage(
      "browser_select_option_by_label",
      validatedParams,
    );
    const snapshot = await captureAriaSnapshot(context);
    return {
      content: [
        {
          type: "text",
          text: `Selected "${validatedParams.option}" in "${validatedParams.label}"`,
        },
        ...snapshot.content,
      ],
    };
  },
};

export const clickByText: Tool = {
  schema: {
    name: ClickByTextTool.shape.name.value,
    description: ClickByTextTool.shape.description.value,
    inputSchema: zodToJsonSchema(ClickByTextTool.shape.arguments),
  },
  handle: async (context: Context, params) => {
    const validatedParams = ClickByTextTool.shape.arguments.parse(params);
    await context.sendSocketMessage("browser_click_by_text", validatedParams);
    const snapshot = await captureAriaSnapshot(context);
    return {
      content: [
        {
          type: "text",
          text: `Clicked "${validatedParams.text}"`,
        },
        ...snapshot.content,
      ],
    };
  },
};
