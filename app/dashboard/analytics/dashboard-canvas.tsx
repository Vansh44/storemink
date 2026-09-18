"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ChartNoAxesCombined,
  ChevronDown,
  ChevronUp,
  EllipsisVertical,
  Eye,
  EyeOff,
  GripVertical,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import {
  resetAnalyticsDashboardLayout,
  saveAnalyticsDashboardLayout,
} from "@/app/actions/analytics-layout";
import {
  MAX_ANALYTICS_SECTIONS,
  analyticsWidgetGridRows,
  availableWidgetSizes,
  defaultAnalyticsSections,
  legacyLayoutFromWidgetIds,
  storedAnalyticsLayout,
  type AnalyticsLayoutItem,
  type AnalyticsLayoutSection,
  type AnalyticsLayoutView,
  type AnalyticsWidgetSize,
} from "@/lib/analytics/layout";
import {
  WIDGETS,
  WIDGET_GROUPS,
  layoutStorageKey,
  normalizeLayout,
  type WidgetId,
} from "./widgets";
import { useUnsavedChangesWarning } from "@/hooks/use-unsaved-changes-warning";

interface DashboardCanvasProps {
  storeId: string;
  slots: Partial<Record<WidgetId, ReactNode>>;
  headerExtras?: ReactNode;
  initialLayout: AnalyticsLayoutView;
  canCustomize?: boolean;
}

const EDITOR_GUIDE_CELLS = 36;

function editorWidgetStyle(widgetId: WidgetId): CSSProperties {
  return {
    "--dash-editor-row-span": analyticsWidgetGridRows(widgetId),
  } as CSSProperties;
}

function cloneSections(
  sections: readonly AnalyticsLayoutSection[],
): AnalyticsLayoutSection[] {
  return sections.map((section) => ({
    ...section,
    items: section.items.map((item) => ({ ...item })),
  }));
}

function readLegacyLayout(
  storeId: string,
  allowed: WidgetId[],
): AnalyticsLayoutSection[] | null {
  try {
    const raw = window.localStorage.getItem(layoutStorageKey(storeId));
    const widgetIds = normalizeLayout(raw ? JSON.parse(raw) : null, allowed);
    return widgetIds ? legacyLayoutFromWidgetIds(widgetIds).sections : null;
  } catch {
    return null;
  }
}

function removeLegacyLayout(storeId: string) {
  try {
    window.localStorage.removeItem(layoutStorageKey(storeId));
  } catch {
    // Server state is authoritative; a blocked localStorage cleanup is harmless.
  }
}

function itemLocation(sections: AnalyticsLayoutSection[], id: string) {
  for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex++) {
    const itemIndex = sections[sectionIndex].items.findIndex(
      (item) => item.widgetId === id,
    );
    if (itemIndex >= 0) return { sectionIndex, itemIndex };
  }
  return null;
}

function dropLocation(sections: AnalyticsLayoutSection[], overId: string) {
  if (overId.startsWith("insert:")) {
    const [, sectionId, rawIndex] = overId.split(":");
    const index = Number(rawIndex);
    if (sectionId && Number.isInteger(index)) return { sectionId, index };
  }
  if (overId.startsWith("section-drop:")) {
    const sectionId = overId.slice("section-drop:".length);
    const section = sections.find((entry) => entry.id === sectionId);
    return section ? { sectionId, index: section.items.length } : null;
  }
  const item = itemLocation(sections, overId);
  return item
    ? {
        sectionId: sections[item.sectionIndex].id,
        index: item.itemIndex,
      }
    : null;
}

export function DashboardCanvas({
  storeId,
  slots,
  headerExtras,
  initialLayout,
  canCustomize = true,
}: DashboardCanvasProps) {
  const allowed = useMemo(
    () => Object.keys(slots).filter((id): id is WidgetId => id in WIDGETS),
    [slots],
  );
  const [layout, setLayout] = useState<AnalyticsLayoutSection[]>(() =>
    cloneSections(initialLayout.sections),
  );
  const [layoutConfigured, setLayoutConfigured] = useState(
    initialLayout.configured,
  );
  const [updatedAt, setUpdatedAt] = useState(initialLayout.updatedAt);
  const [draft, setDraft] = useState<AnalyticsLayoutSection[] | null>(null);
  const [reorderingSections, setReorderingSections] = useState(false);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [resetRequested, setResetRequested] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const legacyAttempted = useRef(false);
  const editorRootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (legacyAttempted.current) return;
    legacyAttempted.current = true;
    if (layoutConfigured) {
      removeLegacyLayout(storeId);
      return;
    }
    const legacy = readLegacyLayout(storeId, allowed);
    if (legacy === null) return;
    startTransition(async () => {
      const result = await saveAnalyticsDashboardLayout(
        storedAnalyticsLayout(legacy),
        null,
      );
      if (result.success) {
        setLayout(cloneSections(legacy));
        setLayoutConfigured(true);
        setUpdatedAt(result.updatedAt ?? null);
        removeLegacyLayout(storeId);
      } else {
        setSaveError(result.error ?? "Couldn't import the browser layout.");
      }
    });
  }, [allowed, layoutConfigured, storeId]);

  const editing = draft !== null;

  useEffect(() => {
    const frame = editorRootRef.current?.closest(".dashboard-frame");
    if (!frame) return;
    frame.classList.toggle("is-analytics-editing", editing);
    return () => frame.classList.remove("is-analytics-editing");
  }, [editing]);

  const sections = draft ?? layout;
  const placed = new Set(
    sections.flatMap((section) => section.items.map((item) => item.widgetId)),
  );
  const hasChanges =
    editing &&
    (resetRequested || JSON.stringify(draft) !== JSON.stringify(layout));

  useUnsavedChangesWarning(hasChanges);

  const startEditing = () => {
    setSaveError(null);
    setResetRequested(false);
    setDraft(cloneSections(layout));
  };
  const cancelEditing = () => {
    setDraft(null);
    setReorderingSections(false);
    setActiveDragId(null);
    setResetRequested(false);
    setSaveError(null);
  };
  const save = () => {
    if (!draft || pending) return;
    const next = cloneSections(draft);
    setSaveError(null);
    startTransition(async () => {
      const result = resetRequested
        ? await resetAnalyticsDashboardLayout(updatedAt)
        : await saveAnalyticsDashboardLayout(
            storedAnalyticsLayout(next),
            updatedAt,
          );
      if (!result.success) {
        setSaveError(result.error ?? "Couldn't save the dashboard.");
        return;
      }
      const saved = resetRequested ? defaultAnalyticsSections(allowed) : next;
      setLayout(cloneSections(saved));
      setLayoutConfigured(!resetRequested);
      setUpdatedAt(result.updatedAt ?? null);
      setDraft(null);
      setReorderingSections(false);
      setActiveDragId(null);
      setResetRequested(false);
      removeLegacyLayout(storeId);
    });
  };
  const changeDraft = useCallback(
    (
      updater: (current: AnalyticsLayoutSection[]) => AnalyticsLayoutSection[],
    ) => {
      setResetRequested(false);
      setDraft((current) => (current ? updater(current) : current));
    },
    [],
  );
  const reset = () => {
    if (
      !window.confirm(
        "Reset this dashboard to StoreMink's current default layout?",
      )
    ) {
      return;
    }
    setDraft(defaultAnalyticsSections(allowed));
    setResetRequested(true);
    setReorderingSections(false);
    setSaveError(null);
  };
  const addSection = () => {
    changeDraft((current) => {
      if (current.length >= MAX_ANALYTICS_SECTIONS) return current;
      const suffix =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `${Date.now()}`;
      return [
        ...current,
        {
          id: `section-${suffix}`,
          title: "New section",
          hidden: false,
          items: [],
        },
      ];
    });
  };
  const addCard = (sectionId: string, widgetId: WidgetId, index?: number) => {
    changeDraft((current) =>
      current.map((section) =>
        section.id === sectionId
          ? {
              ...section,
              items: section.items.some((item) => item.widgetId === widgetId)
                ? section.items
                : [
                    ...section.items.slice(0, index ?? section.items.length),
                    {
                      widgetId,
                      size: availableWidgetSizes(widgetId)[0],
                    },
                    ...section.items.slice(index ?? section.items.length),
                  ],
            }
          : section,
      ),
    );
    toast("Card added", {
      action: {
        label: "Undo",
        onClick: () => {
          removeCard(widgetId, false);
        },
      },
    });
  };
  const removeCard = (widgetId: WidgetId, announce = true) => {
    const location = itemLocation(sections, widgetId);
    const removedItem = location
      ? sections[location.sectionIndex].items[location.itemIndex]
      : null;
    const removedSectionId = location
      ? sections[location.sectionIndex].id
      : null;
    changeDraft((current) =>
      current.map((section) => ({
        ...section,
        items: section.items.filter((item) => item.widgetId !== widgetId),
      })),
    );
    if (announce && removedItem && removedSectionId && location) {
      toast("Card removed", {
        action: {
          label: "Undo",
          onClick: () =>
            changeDraft((current) =>
              current.map((section) =>
                section.id === removedSectionId
                  ? {
                      ...section,
                      items: [
                        ...section.items.slice(0, location.itemIndex),
                        removedItem,
                        ...section.items.slice(location.itemIndex),
                      ],
                    }
                  : section,
              ),
            ),
        },
      });
    }
  };
  const resizeCard = (widgetId: WidgetId, size: AnalyticsWidgetSize) =>
    changeDraft((current) =>
      current.map((section) => ({
        ...section,
        items: section.items.map((item) =>
          item.widgetId === widgetId ? { ...item, size } : item,
        ),
      })),
    );
  const moveCard = (widgetId: WidgetId, sectionId: string) =>
    changeDraft((current) => {
      const source = itemLocation(current, widgetId);
      if (!source) return current;
      const item = current[source.sectionIndex].items[source.itemIndex];
      return current.map((section) => ({
        ...section,
        items:
          section.id === sectionId
            ? [
                ...section.items.filter((entry) => entry.widgetId !== widgetId),
                item,
              ]
            : section.items.filter((entry) => entry.widgetId !== widgetId),
      }));
    });

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  const onDragStart = (event: DragStartEvent) => {
    setActiveDragId(String(event.active.id));
  };
  const onDragEnd = (event: DragEndEvent) => {
    const activeId = String(event.active.id);
    const overId = event.over ? String(event.over.id) : null;
    setActiveDragId(null);
    if (!overId || activeId === overId) return;

    if (activeId.startsWith("library:")) {
      const widgetId = activeId.slice("library:".length) as WidgetId;
      if (!(widgetId in WIDGETS) || placed.has(widgetId)) return;
      const target = dropLocation(sections, overId);
      if (!target) return;
      addCard(target.sectionId, widgetId, target.index);
      return;
    }

    changeDraft((current) => {
      const source = itemLocation(current, activeId);
      if (!source) return current;
      const moving = current[source.sectionIndex].items[source.itemIndex];
      const target = dropLocation(current, overId);
      if (!target) return current;

      const next = cloneSections(current);
      next[source.sectionIndex].items.splice(source.itemIndex, 1);
      const targetSectionIndex = next.findIndex(
        (section) => section.id === target.sectionId,
      );
      if (targetSectionIndex < 0) return current;
      let targetIndex = Math.min(
        target.index,
        next[targetSectionIndex].items.length,
      );
      if (
        source.sectionIndex === targetSectionIndex &&
        source.itemIndex < targetIndex
      ) {
        targetIndex -= 1;
      }
      next[targetSectionIndex].items.splice(targetIndex, 0, moving);
      return next;
    });
  };

  const renderedSections = editing
    ? sections
    : sections.filter((section) => !section.hidden && section.items.length > 0);

  const libraryTargetSectionId =
    sections.find((section) => !section.hidden)?.id ?? sections[0]?.id ?? null;
  const activeWidgetId = activeDragId?.startsWith("library:")
    ? (activeDragId.slice("library:".length) as WidgetId)
    : (activeDragId as WidgetId | null);
  return (
    <div
      ref={editorRootRef}
      className={editing ? "dash-editor-mode" : undefined}
    >
      {editing ? (
        <div className="dash-savebar">
          <div className="dash-savebar-msg">
            <span className="dash-savebar-dot" aria-hidden />
            <span>
              {hasChanges ? "Unsaved changes" : "Editing dashboard"}
              {saveError ? (
                <span className="dash-savebar-error" role="alert">
                  {saveError}
                </span>
              ) : null}
            </span>
          </div>
          <div className="dash-savebar-actions">
            <button
              type="button"
              className="dash-sb-btn"
              onClick={cancelEditing}
            >
              Cancel
            </button>
            <button
              type="button"
              className="dash-sb-btn is-primary"
              onClick={save}
              disabled={pending || !hasChanges}
            >
              {pending ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      ) : null}

      {editing ? (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={onDragStart}
          onDragCancel={() => setActiveDragId(null)}
          onDragEnd={onDragEnd}
        >
          <div className="dash-editor-shell">
            <WidgetLibraryRail
              allowed={allowed}
              placed={placed}
              canAdd={libraryTargetSectionId !== null}
              onAdd={(widgetId) => {
                if (libraryTargetSectionId) {
                  const targetSection = sections.find(
                    (section) => section.id === libraryTargetSectionId,
                  );
                  addCard(
                    libraryTargetSectionId,
                    widgetId,
                    Math.min(4, targetSection?.items.length ?? 0),
                  );
                }
              }}
            />

            <main className="dash-editor-main">
              <header className="dash-an-head">
                <h1>
                  <ChartNoAxesCombined aria-hidden /> Analytics
                </h1>
                <div className="dash-an-actions">
                  <button
                    type="button"
                    className="dash-an-btn"
                    onClick={addSection}
                    disabled={sections.length >= MAX_ANALYTICS_SECTIONS}
                  >
                    <Plus /> Add section
                  </button>
                  <button
                    type="button"
                    className={`dash-an-btn${reorderingSections ? " is-active" : ""}`}
                    onClick={() => setReorderingSections((value) => !value)}
                    disabled={sections.length < 2}
                  >
                    Reorder sections
                  </button>
                  <button
                    type="button"
                    className="dash-an-btn"
                    onClick={reset}
                    disabled={pending}
                  >
                    Reset to default
                  </button>
                </div>
              </header>

              <div className="dash-sections is-editing">
                {renderedSections.map((section, index) => (
                  <EditableSection
                    key={section.id}
                    section={section}
                    index={index}
                    total={sections.length}
                    slots={slots}
                    sections={sections}
                    reordering={reorderingSections}
                    showInsertionGuides={
                      hasChanges ||
                      activeDragId?.startsWith("library:") === true
                    }
                    onRemove={removeCard}
                    onResize={resizeCard}
                    onMoveCard={moveCard}
                    onChange={(patch) =>
                      changeDraft((current) =>
                        current.map((entry) =>
                          entry.id === section.id
                            ? { ...entry, ...patch }
                            : entry,
                        ),
                      )
                    }
                    onDelete={() =>
                      changeDraft((current) =>
                        current.filter((entry) => entry.id !== section.id),
                      )
                    }
                    onMoveSection={(direction) =>
                      changeDraft((current) => {
                        const to = index + direction;
                        if (to < 0 || to >= current.length) return current;
                        const next = [...current];
                        const [moving] = next.splice(index, 1);
                        next.splice(to, 0, moving);
                        return next;
                      })
                    }
                  />
                ))}
              </div>

              {renderedSections.length === 0 ? (
                <div className="dash-canvas-empty">
                  <p>Your dashboard is empty.</p>
                  <button
                    type="button"
                    className="dash-an-btn"
                    onClick={addSection}
                  >
                    <Plus /> Add a section
                  </button>
                </div>
              ) : null}
            </main>
          </div>
          <DragOverlay dropAnimation={null}>
            {activeWidgetId && activeWidgetId in WIDGETS ? (
              <div className="dash-drag-preview">
                <GripVertical aria-hidden /> {WIDGETS[activeWidgetId].title}
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      ) : (
        <>
          <header className="dash-an-head">
            <h1>Analytics</h1>
            <div className="dash-an-actions">
              {headerExtras}
              {canCustomize ? (
                <button
                  type="button"
                  className="dash-an-btn"
                  onClick={startEditing}
                >
                  Edit dashboard
                </button>
              ) : null}
            </div>
          </header>
          <div className="dash-sections">
            {renderedSections.map((section) => (
              <section key={section.id} className="dash-section">
                <h2>{section.title}</h2>
                <div className="dash-canvas">
                  {section.items.map((item) => (
                    <Widget
                      key={item.widgetId}
                      item={item}
                      node={slots[item.widgetId]}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
          {renderedSections.length === 0 ? (
            <div className="dash-canvas-empty">
              <p>Your dashboard is empty.</p>
              {canCustomize ? (
                <button
                  type="button"
                  className="dash-an-btn"
                  onClick={startEditing}
                >
                  <Plus /> Edit dashboard
                </button>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

function Widget({
  item,
  node,
}: {
  item: AnalyticsLayoutItem;
  node: ReactNode;
}) {
  return (
    <div className={`dash-widget size-${item.size}`}>
      <div className="dash-widget-body">{node}</div>
    </div>
  );
}

function EditableSection({
  section,
  index,
  total,
  slots,
  sections,
  reordering,
  showInsertionGuides,
  onRemove,
  onResize,
  onMoveCard,
  onChange,
  onDelete,
  onMoveSection,
}: {
  section: AnalyticsLayoutSection;
  index: number;
  total: number;
  slots: Partial<Record<WidgetId, ReactNode>>;
  sections: AnalyticsLayoutSection[];
  reordering: boolean;
  showInsertionGuides: boolean;
  onRemove: (id: WidgetId) => void;
  onResize: (id: WidgetId, size: AnalyticsWidgetSize) => void;
  onMoveCard: (id: WidgetId, sectionId: string) => void;
  onChange: (patch: Partial<AnalyticsLayoutSection>) => void;
  onDelete: () => void;
  onMoveSection: (direction: -1 | 1) => void;
}) {
  const [editingTitle, setEditingTitle] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  return (
    <section
      className={`dash-section-editor${section.hidden ? " is-hidden" : ""}`}
    >
      <div className="dash-section-editor-head">
        {editingTitle ? (
          <input
            autoFocus
            value={section.title}
            maxLength={60}
            aria-label="Section title"
            onChange={(event) => onChange({ title: event.target.value })}
            onBlur={() => setEditingTitle(false)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === "Escape") {
                setEditingTitle(false);
              }
            }}
          />
        ) : (
          <h2>
            {section.title}
            {section.hidden ? <span>Hidden</span> : null}
          </h2>
        )}
        <div className="dash-section-editor-actions">
          {reordering ? (
            <>
              <button
                type="button"
                onClick={() => onMoveSection(-1)}
                disabled={index === 0}
                aria-label={`Move ${section.title} up`}
              >
                <ChevronUp />
              </button>
              <button
                type="button"
                onClick={() => onMoveSection(1)}
                disabled={index === total - 1}
                aria-label={`Move ${section.title} down`}
              >
                <ChevronDown />
              </button>
            </>
          ) : null}
          <button
            type="button"
            onClick={() => setEditingTitle(true)}
            aria-label={`Rename ${section.title}`}
          >
            <Pencil />
          </button>
          <button
            type="button"
            onClick={() => onChange({ hidden: !section.hidden })}
            aria-label={`${section.hidden ? "Show" : "Hide"} ${section.title}`}
          >
            {section.hidden ? <Eye /> : <EyeOff />}
          </button>
          <button
            type="button"
            onClick={onDelete}
            aria-label={`Delete ${section.title}`}
          >
            <Trash2 />
          </button>
          <button
            type="button"
            onClick={() => setCollapsed((value) => !value)}
            aria-label={`${collapsed ? "Expand" : "Collapse"} ${section.title}`}
            aria-expanded={!collapsed}
          >
            {collapsed ? <ChevronDown /> : <ChevronUp />}
          </button>
        </div>
      </div>
      {!collapsed ? (
        <SectionGrid section={section}>
          {section.items.map((item) => (
            <SortableWidget
              key={item.widgetId}
              item={item}
              node={slots[item.widgetId]}
              sections={sections}
              currentSectionId={section.id}
              onRemove={() => onRemove(item.widgetId)}
              onResize={(size) => onResize(item.widgetId, size)}
              onMove={(sectionId) => onMoveCard(item.widgetId, sectionId)}
            />
          ))}
          {Array.from({
            length:
              showInsertionGuides || section.items.length === 0
                ? EDITOR_GUIDE_CELLS
                : 0,
          }).map((_, guideIndex) => (
            <InsertionSlot
              key={`insert-${guideIndex}`}
              sectionId={section.id}
              index={section.items.length + guideIndex}
            />
          ))}
        </SectionGrid>
      ) : null}
    </section>
  );
}

function SectionGrid({
  section,
  children,
}: {
  section: AnalyticsLayoutSection;
  children: ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: `section-drop:${section.id}`,
  });
  return (
    <SortableContext
      items={section.items.map((item) => item.widgetId)}
      strategy={rectSortingStrategy}
    >
      <div
        ref={setNodeRef}
        className={`dash-canvas${isOver ? " is-drop-target" : ""}`}
      >
        {children}
        {section.items.length === 0 ? (
          <span className="sr-only">Drop or add a card here</span>
        ) : null}
      </div>
    </SortableContext>
  );
}

function InsertionSlot({
  sectionId,
  index,
}: {
  sectionId: string;
  index: number;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: `insert:${sectionId}:${index}`,
  });
  return (
    <div
      ref={setNodeRef}
      className={`dash-slot-placeholder is-insertion${isOver ? " is-over" : ""}`}
      aria-hidden
    />
  );
}

function SortableWidget({
  item,
  node,
  sections,
  currentSectionId,
  onRemove,
  onResize,
  onMove,
}: {
  item: AnalyticsLayoutItem;
  node: ReactNode;
  sections: AnalyticsLayoutSection[];
  currentSectionId: string;
  onRemove: () => void;
  onResize: (size: AnalyticsWidgetSize) => void;
  onMove: (sectionId: string) => void;
}) {
  const meta = WIDGETS[item.widgetId];
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.widgetId });
  return (
    <div
      ref={setNodeRef}
      data-widget-id={item.widgetId}
      className={`dash-widget size-${item.size}${isDragging ? " is-dragging" : ""}`}
      style={{
        ...editorWidgetStyle(item.widgetId),
        transform: CSS.Transform.toString(transform),
        transition,
      }}
    >
      <div className="dash-widget-bar">
        <button
          type="button"
          className="dash-widget-grip"
          aria-label={`Move ${meta.title}`}
          {...attributes}
          {...listeners}
        >
          <GripVertical />
        </button>
        <details className="dash-widget-menu">
          <summary aria-label={`Card options for ${meta.title}`}>
            <EllipsisVertical />
          </summary>
          <div>
            <label>
              Card size
              <select
                value={item.size}
                aria-label={`Size of ${meta.title}`}
                onChange={(event) =>
                  onResize(event.target.value as AnalyticsWidgetSize)
                }
              >
                {availableWidgetSizes(item.widgetId).map((size) => (
                  <option key={size} value={size}>
                    {size[0].toUpperCase() + size.slice(1)}
                  </option>
                ))}
              </select>
            </label>
            {sections.length > 1 ? (
              <label>
                Section
                <select
                  value={currentSectionId}
                  aria-label={`Section for ${meta.title}`}
                  onChange={(event) => onMove(event.target.value)}
                >
                  {sections.map((section) => (
                    <option key={section.id} value={section.id}>
                      {section.title}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </div>
        </details>
        <button
          type="button"
          className="dash-widget-x"
          aria-label={`Remove ${meta.title}`}
          onClick={onRemove}
        >
          <X />
        </button>
      </div>
      <div className="dash-widget-body">{node}</div>
    </div>
  );
}

function WidgetLibraryRail({
  allowed,
  placed,
  canAdd,
  onAdd,
}: {
  allowed: WidgetId[];
  placed: Set<WidgetId>;
  canAdd: boolean;
  onAdd: (id: WidgetId) => void;
}) {
  const [query, setQuery] = useState("");
  const normalized = query.trim().toLowerCase();
  const matches = allowed.filter((id) => {
    if (!normalized) return true;
    const meta = WIDGETS[id];
    return (
      meta.title.toLowerCase().includes(normalized) ||
      meta.description.toLowerCase().includes(normalized)
    );
  });

  return (
    <aside className="dash-widget-library" aria-label="Analytics card library">
      <div className="dash-lib-search">
        <Search />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search"
          aria-label="Search cards"
        />
      </div>
      <div className="dash-lib-list">
        {matches.length === 0 ? (
          <p className="dash-lib-empty">No cards match that search.</p>
        ) : (
          WIDGET_GROUPS.map((group) => {
            const items = matches.filter((id) => WIDGETS[id].group === group);
            if (items.length === 0) return null;
            return (
              <div key={group} className="dash-lib-group">
                <div className="dash-lib-group-label">{group}</div>
                {items.map((id) => (
                  <DraggableLibraryItem
                    key={id}
                    id={id}
                    added={placed.has(id)}
                    disabled={!canAdd}
                    onAdd={() => onAdd(id)}
                  />
                ))}
              </div>
            );
          })
        )}
      </div>
      <p className="dash-lib-help">
        Drag a card into a dotted space, or click its name to add it.
      </p>
    </aside>
  );
}

function DraggableLibraryItem({
  id,
  added,
  disabled,
  onAdd,
}: {
  id: WidgetId;
  added: boolean;
  disabled: boolean;
  onAdd: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({
      id: `library:${id}`,
      disabled: added || disabled,
    });
  return (
    <button
      ref={setNodeRef}
      type="button"
      className={`dash-lib-item${added ? " is-added" : ""}${isDragging ? " is-dragging" : ""}`}
      style={{ transform: CSS.Transform.toString(transform) }}
      onClick={onAdd}
      disabled={added || disabled}
      {...attributes}
      {...listeners}
    >
      <GripVertical aria-hidden />
      <span>
        <span className="dash-lib-item-title">{WIDGETS[id].title}</span>
        <span className="dash-lib-item-desc">{WIDGETS[id].description}</span>
      </span>
      {added ? <span className="dash-lib-added">Added</span> : <Plus />}
    </button>
  );
}
