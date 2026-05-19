import { useCallback, useState } from "react";
import { Icon } from "@iconify/react";
import {
  ReactFlow,
  Background,
  MiniMap,
  Controls,
  useNodesState,
  useEdgesState,
  type NodeTypes,
  type EdgeTypes,
  type NodeMouseHandler,
  type Node,
  BackgroundVariant,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { IconButton, Button } from "@buffered-audio/design-system";
import type { MenuItem } from "@buffered-audio/design-system";
import { DemoNode } from "../components/graph/DemoNode";
import { DemoEdge } from "../components/graph/DemoEdge";
import { DemoContextMenu } from "../components/graph/DemoContextMenu";
import { DemoTabBar } from "../DemoTabBar";
import { demoNodes, demoEdges } from "../data/demoGraph";

const GRAPH_TABS = [
  { id: "podcast", label: "podcast-raw.wav" },
  { id: "interview", label: "interview-backup.wav" },
] as const;

const MENU_ITEMS: ReadonlyArray<MenuItem> = [
  { kind: "action", icon: "lucide:file-plus", label: "New Session", shortcut: "Ctrl+N" },
  { kind: "action", icon: "lucide:folder-open", label: "Open Session", shortcut: "Ctrl+O" },
  { kind: "action", icon: "lucide:save", label: "Save", shortcut: "Ctrl+S" },
  { kind: "action", icon: "lucide:save-all", label: "Save As\u2026", shortcut: "Ctrl+Shift+S" },
  { kind: "separator" },
  { kind: "action", icon: "lucide:app-window", label: "New Window", shortcut: "Ctrl+Shift+N" },
  { kind: "action", icon: "lucide:x", label: "Close Window", shortcut: "Ctrl+W" },
  { kind: "separator" },
  { kind: "action", icon: "lucide:undo-2", label: "Undo", shortcut: "Ctrl+Z" },
  { kind: "action", icon: "lucide:redo-2", label: "Redo", shortcut: "Ctrl+Shift+Z" },
  { kind: "separator" },
  { kind: "action", icon: "lucide:settings", label: "Settings", shortcut: "Ctrl+," },
];

const NODE_TYPES: NodeTypes = { audioNode: DemoNode };
const EDGE_TYPES: EdgeTypes = { audioEdge: DemoEdge };

interface ContextMenuState {
  readonly x: number;
  readonly y: number;
}

function GraphPageInner() {
  const [nodes, , onNodesChange] = useNodesState(demoNodes);
  const [edges, , onEdgesChange] = useEdgesState(demoEdges);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  const handleContextMenu = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    setContextMenu({ x: event.clientX, y: event.clientY });
  }, []);

  const handleNodeContextMenu: NodeMouseHandler<Node> = useCallback((event, _node) => {
    event.preventDefault();
    setContextMenu({ x: event.clientX, y: event.clientY });
  }, []);

  const handlePaneContextMenu = useCallback((event: React.MouseEvent | MouseEvent) => {
    event.preventDefault();
    setContextMenu({ x: event.clientX, y: event.clientY });
  }, []);

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  const handlePaneClick = useCallback(() => {
    setContextMenu(null);
  }, []);

  return (
    <div className="flex h-full w-full flex-col">
    <DemoTabBar tabs={GRAPH_TABS} activeTabId="podcast" menuItems={MENU_ITEMS} />
    <div
      className="relative min-h-0 flex-1"
      onContextMenu={handleContextMenu}
    >
      <style>{`
        .react-flow {
          --xy-background-color: var(--color-void);
          --xy-node-border-radius: 0;
          --xy-node-boxshadow-default: 0 2px 8px rgba(0, 0, 0, 0.5);
          --xy-node-boxshadow-hover: 0 4px 16px rgba(0, 0, 0, 0.6);
          --xy-node-boxshadow-selected: 0 4px 16px rgba(0, 0, 0, 0.6);
          --xy-minimap-background: var(--color-chrome-surface);
          --xy-minimap-mask-background: var(--color-chrome-base);
          --xy-controls-button-background: var(--color-chrome-raised);
          --xy-controls-button-color: var(--color-chrome-text);
          --xy-controls-button-border-color: transparent;
          --xy-edge-stroke-default: var(--color-edge-idle);
          --xy-handle-background: var(--color-chrome-surface);
          --xy-handle-border-color: transparent;
          --xy-selection-background: var(--color-data-selection);
          --xy-selection-border: none;
        }

        .react-flow .react-flow__controls {
          border: none;
          border-radius: 0;
          box-shadow: none;
          background: var(--color-chrome-raised);
        }

        .react-flow .react-flow__controls button {
          background: var(--color-chrome-raised);
          border: none;
          border-radius: 0;
          width: 28px;
          height: 28px;
          padding: 4px;
        }

        .react-flow .react-flow__controls button:hover {
          background: var(--color-interactive-hover);
        }

        .react-flow .react-flow__controls svg {
          fill: var(--color-chrome-text);
        }

        .react-flow .react-flow__minimap {
          border: none;
          border-radius: 0;
          box-shadow: none;
          background: var(--color-chrome-surface);
        }

        .react-flow .react-flow__node {
          border-radius: 0;
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.5);
          padding: 0;
        }

        .react-flow .react-flow__attribution {
          display: none;
        }

        @keyframes pulse-header {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }

        @keyframes dash-flow {
          from { stroke-dashoffset: 10; }
          to { stroke-dashoffset: 0; }
        }
      `}</style>

      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        onNodeContextMenu={handleNodeContextMenu}
        onPaneContextMenu={handlePaneContextMenu}
        onPaneClick={handlePaneClick}
        fitView
        fitViewOptions={{ padding: 0.3 }}
        defaultEdgeOptions={{ type: "audioEdge" }}
        proOptions={{ hideAttribution: true }}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={20}
          size={1}
          color="var(--chrome-border-subtle)"
        />
        <MiniMap
          nodeColor="var(--chrome-raised)"
          nodeStrokeColor="var(--chrome-border-subtle)"
          nodeStrokeWidth={1}
          maskColor="var(--chrome-base)"
          position="bottom-left"
          pannable
          zoomable
        />
        <Controls showInteractive={false} position="bottom-left" style={{ marginLeft: 220 }} />
      </ReactFlow>

      {/* Top-left: Edge key + Inspecting */}
      <div className="absolute top-3 left-3 z-10 flex items-center gap-3">
        <div className="flex items-center gap-4 bg-chrome-surface px-3 py-2">
          {[
            { label: "Idle", color: "var(--color-edge-idle)" },
            { label: "Active", color: "var(--color-edge-active)" },
            { label: "Complete", color: "var(--color-edge-complete)" },
          ].map((item) => (
            <div key={item.label} className="flex items-center gap-1.5">
              <svg width={16} height={3}>
                <line x1={0} y1={1.5} x2={16} y2={1.5} stroke={item.color} strokeWidth={1.5} />
              </svg>
              <span className="font-technical text-[length:var(--text-xs)] uppercase tracking-[0.06em] text-chrome-text-secondary">
                {item.label}
              </span>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-2 bg-chrome-surface px-3 py-2">
          <Icon icon="lucide:eye" width={14} height={14} className="text-primary" />
          <span className="font-technical text-[length:var(--text-xs)] uppercase tracking-[0.06em] text-chrome-text-dim">
            Inspecting:
          </span>
          <span className="font-body text-[length:var(--text-sm)] text-chrome-text">
            podcast-raw.wav
          </span>
        </div>
      </div>

      {/* Top-right: Undo/redo + Render */}
      <div className="absolute top-3 right-3 z-10 flex items-center gap-3">
        <IconButton icon="lucide:layout-grid" label="Auto organize" />
        <IconButton icon="lucide:undo-2" label="Undo" />
        <IconButton icon="lucide:redo-2" label="Redo" dim />
        <Button variant="secondary" size="xl">
          <span className="flex items-center gap-2">
            <Icon icon="lucide:play" width={16} height={16} />
            <span>Render</span>
            <Icon icon="lucide:chevron-down" width={12} height={12} />
          </span>
        </Button>
      </div>

      {/* Bottom-right: Add node */}
      <div className="absolute bottom-3 right-3 z-10">
        <Button variant="primary" size="xl">
          <span className="flex items-center gap-2">
            <Icon icon="lucide:plus" width={16} height={16} />
            <span>Add Node</span>
          </span>
        </Button>
      </div>

      {contextMenu && (
        <DemoContextMenu
          position={contextMenu}
          onClose={closeContextMenu}
        />
      )}
    </div>
    </div>
  );
}

export function GraphPage() {
  return <GraphPageInner />;
}
