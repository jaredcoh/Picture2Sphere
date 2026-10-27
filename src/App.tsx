import { Canvas, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { Box, Crosshair, Download, ImageUp, Minus, Moon, Pencil, Plus, RotateCcw, RotateCw, Save, Sun, Upload, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import * as THREE from "three";
import {
  applyColorAdjustments,
  colorDistance,
  createFilament,
  createDefaultFilaments,
  rgbToHex,
  hexToRgb,
  normalizeHex,
  safeFileStamp,
  type FilamentPreset,
} from "./colorUtils";
import type { ThreeMfEntry } from "./export3mf";
import {
  estimateFullSpectrumPatternCapacity,
  generateFullSpectrumPatterns,
  type FullSpectrumPattern,
} from "./fullSpectrumPatterns";
import {
  createPlaceholderPanorama,
  createGeneratedColorTexture,
  loadImageFile,
  MAX_UPLOAD_IMAGE_PIXELS,
  simulateFullSpectrumPrintedTexture,
  type LoadedImageInfo,
  wrapPanoramaCanvas,
} from "./imageProcessing";
import { applyMeshRotation, chooseBestOrientation } from "./orientationUtils";
import { generatePedestalMesh, generateSphereMesh } from "./sphereMesh";
import { normalizeRightAngle, transformTextureUv } from "./textureMapping";
import type {
  FilamentChannel,
  FilamentRole,
  RotationDeg,
  Rgb,
  ExportProfile,
  ProcessingSettings,
  SphereMesh,
  SphereSettings,
} from "./types";

type PreviewMode = "original" | "generated" | "printed";
type PreviewBackground = "day" | "night";
type PreviewShapeView = "ball" | "flat";
type DiameterUnit = "mm" | "in";
type PreviewAxisLock = "free" | "x" | "y" | "z";
type PreviewLockedAxis = Exclude<PreviewAxisLock, "free">;
type ActiveFilamentPalette = FilamentPreset | "custom";
const MM_PER_INCH = 25.4;
const FILAMENT_OPTIMIZED_RESOLUTION: SphereSettings["resolution"] = "ultra";
const DEFAULT_PHYSICAL_FILAMENT_COUNT = 4;
const MIN_CUSTOM_FILAMENT_COUNT = 2;
const MAX_CUSTOM_FILAMENT_COUNT = 5;
const FILAMENT_INVENTORY_STORAGE_KEY = "sphere-panorama-filament-inventory";
const MAX_FILAMENT_INVENTORY_IMPORT_BYTES = 1024 * 1024;
const MAX_PROJECT_IMPORT_BYTES = 32 * 1024 * 1024;
const PROJECT_FILE_VERSION = 1;
const AUTO_PICK_SAMPLE_TARGET = 1600;
const AUTO_PICK_COLOR_BUCKET_LIMIT = 180;
const MIN_TOTAL_COLOR_COUNT = 84;
const MAX_TOTAL_COLOR_COUNT = 124;
const PREVIEW_AXIS_LOCK_OPTIONS: Array<{ value: PreviewAxisLock; label: string }> = [
  { value: "free", label: "Free" },
  { value: "x", label: "X" },
  { value: "y", label: "Y" },
  { value: "z", label: "Z" },
];
const PREVIEW_ROTATION_DRAG_DEG_PER_PIXEL = 0.42;
const DEFAULT_AUTO_SPIN_SPEED = 0.48;
const MIN_AUTO_SPIN_SPEED = DEFAULT_AUTO_SPIN_SPEED / 2;
const MAX_AUTO_SPIN_SPEED = DEFAULT_AUTO_SPIN_SPEED * 2;
const MIN_PREVIEW_ZOOM = 0.72;
const MAX_PREVIEW_ZOOM = 1.85;
const PREVIEW_LOADING_MIN_MS = 420;
const PREVIEW_SAMPLE_DENSITY = 512;

interface PanoramaOffset {
  x: number;
  y: number;
}

interface EditableFilament {
  id: string;
  name: string;
  hex: string;
  role: FilamentRole;
}

interface ImageColorSample {
  rgb: Rgb;
  weight: number;
}

interface PaletteCoverageStats {
  colorPercents: number[];
  physicalFilamentPercents: number[];
}

interface GeneratedColorBounds {
  minTotal: number;
  maxTotal: number;
  maxPatternCount: number;
}

interface SphereProjectFile {
  version: number;
  sphereSettings: SphereSettings;
  processingSettings: ProcessingSettings;
  filaments: FilamentChannel[];
  customPalette: FilamentChannel[] | null;
  patternCalibrations: Record<string, string>;
  pedestalFilamentIndex: number;
  showAssembledPedestal: boolean;
  panoramaOffset: PanoramaOffset;
  panoramaRotationDeg: number;
  guideRotationDeg: number;
  exportProfile: ExportProfile;
  image: {
    fileName: string;
    originalWidth: number;
    originalHeight: number;
    dataUrl: string;
  } | null;
}

const defaultSphereSettings: SphereSettings = {
  diameterMm: 80,
  resolution: FILAMENT_OPTIMIZED_RESOLUTION,
  hollow: true,
  wallThicknessMm: 5,
  layerHeightMm: 0.08,
  flatBase: "none",
  pedestalWidthMm: 70,
  pedestalLengthMm: 70,
  pedestalHeightMm: 12,
  splitMode: "full",
  orientationMode: "auto",
  rotationDeg: { x: 0, y: 0, z: 0 },
};

const defaultProcessingSettings: ProcessingSettings = {
  mode: "fullTexture",
  brightness: 0,
  contrast: 105,
  saturation: 115,
  gamma: 1,
  ditherStrength: 0.55,
  fullSpectrumComboColors: 40,
  fullSpectrumPatternCount: MIN_TOTAL_COLOR_COUNT - DEFAULT_PHYSICAL_FILAMENT_COUNT,
  sampleDensity: 1024,
};

function App() {
  const initialProcessingSettings = useMemo(
    () => ({ ...defaultProcessingSettings, mode: "dither" as const }),
    [],
  );
  const [sourceCanvas, setSourceCanvas] = useState<HTMLCanvasElement>(() => createPlaceholderPanorama());
  const [imageInfo, setImageInfo] = useState<LoadedImageInfo | null>(null);
  const [sphereSettings, setSphereSettings] = useState<SphereSettings>(defaultSphereSettings);
  const [processingSettings, setProcessingSettings] = useState<ProcessingSettings>(initialProcessingSettings);
  const [previewProcessingSettings, setPreviewProcessingSettings] =
    useState<ProcessingSettings>(initialProcessingSettings);
  const [filaments, setFilaments] = useState<FilamentChannel[]>(() => createDefaultFilaments("black"));
  const [customPalette, setCustomPalette] = useState<FilamentChannel[] | null>(null);
  const [patternCalibrations, setPatternCalibrations] = useState<Record<string, string>>({});
  const [customPaletteDraft, setCustomPaletteDraft] = useState<EditableFilament[]>(() =>
    createDefaultCustomPaletteDraft(),
  );
  const [filamentInventoryText, setFilamentInventoryText] = useState(() => loadFilamentInventoryText());
  const [customPaletteModalOpen, setCustomPaletteModalOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [previewMode, setPreviewMode] = useState<PreviewMode>("generated");
  const [previewShapeView, setPreviewShapeView] = useState<PreviewShapeView>("ball");
  const [previewBackground, setPreviewBackground] = useState<PreviewBackground>("night");
  const [previewAxisLock, setPreviewAxisLock] = useState<PreviewAxisLock>("free");
  const [previewRotationDeg, setPreviewRotationDeg] = useState<RotationDeg>({ x: 0, y: 0, z: 0 });
  const [previewZoom, setPreviewZoom] = useState(1);
  const [autoSpinEnabled, setAutoSpinEnabled] = useState(false);
  const [autoSpinSpeed, setAutoSpinSpeed] = useState(DEFAULT_AUTO_SPIN_SPEED);
  const [diameterUnit, setDiameterUnit] = useState<DiameterUnit>("mm");
  const [exportProfile, setExportProfile] = useState<ExportProfile>("snapmakerOrca");
  const [pedestalFilamentIndex, setPedestalFilamentIndex] = useState(0);
  const [showAssembledPedestal, setShowAssembledPedestal] = useState(false);
  const [panoramaOffset, setPanoramaOffset] = useState<PanoramaOffset>({ x: 0, y: 0 });
  const [panoramaRotationDeg, setPanoramaRotationDeg] = useState(0);
  const [guideRotationDeg, setGuideRotationDeg] = useState(0);
  const [alignmentOpen, setAlignmentOpen] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const [status, setStatus] = useState("Upload a panorama image to enable export. The sample is preview-only.");
  const [isBusy, setIsBusy] = useState(false);
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const previewUpdateTimerRef = useRef<number | null>(null);
  const previewLoadingFrameRef = useRef<number | null>(null);
  const previewLoadingHideTimerRef = useRef<number | null>(null);

  useEffect(() => {
    console.info("[SpherePanorama] App mounted.", {
      webglAvailable: isWebGlAvailable(),
      canvas2dAvailable: Boolean(document.createElement("canvas").getContext("2d")),
    });
  }, []);

  useEffect(() => {
    return () => {
      if (previewUpdateTimerRef.current !== null) {
        window.clearTimeout(previewUpdateTimerRef.current);
      }
      if (previewLoadingFrameRef.current !== null) {
        window.cancelAnimationFrame(previewLoadingFrameRef.current);
      }
      if (previewLoadingHideTimerRef.current !== null) {
        window.clearTimeout(previewLoadingHideTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    saveFilamentInventoryText(filamentInventoryText);
  }, [filamentInventoryText]);

  const activeAutoSpinAxis: PreviewLockedAxis = previewAxisLock === "free" ? "z" : previewAxisLock;

  useEffect(() => {
    if (!autoSpinEnabled) {
      return;
    }

    let frame: number | null = null;
    let lastFrameMs = performance.now();

    function animate(nowMs: number) {
      const deltaSeconds = Math.min(0.08, Math.max(0, (nowMs - lastFrameMs) / 1000));
      lastFrameMs = nowMs;
      setPreviewRotationDeg((current) => ({
        ...current,
        [activeAutoSpinAxis]: normalizeRotationDeg(
          current[activeAutoSpinAxis] + radiansToDegrees(autoSpinSpeed * deltaSeconds),
        ),
      }));
      frame = window.requestAnimationFrame(animate);
    }

    frame = window.requestAnimationFrame(animate);

    return () => {
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, [activeAutoSpinAxis, autoSpinEnabled, autoSpinSpeed]);

  const alignedCanvas = useMemo(
    () => wrapPanoramaCanvas(sourceCanvas, panoramaOffset.x, panoramaOffset.y, panoramaRotationDeg),
    [sourceCanvas, panoramaOffset.x, panoramaOffset.y, panoramaRotationDeg],
  );
  const filamentInventory = useMemo(() => parseFilamentInventory(filamentInventoryText), [filamentInventoryText]);

  const effectivePreviewProcessingSettings = useMemo(
    () => ({
      ...previewProcessingSettings,
      sampleDensity: Math.min(PREVIEW_SAMPLE_DENSITY, previewProcessingSettings.sampleDensity),
      fullSpectrumDiameterMm: sphereSettings.diameterMm,
      fullSpectrumLayerHeightMm: sphereSettings.layerHeightMm,
    }),
    [previewProcessingSettings, sphereSettings.diameterMm, sphereSettings.layerHeightMm],
  );

  const physicalFilamentCount = filaments.length;
  const generatedColorBounds = useMemo(() => getGeneratedColorBounds(filaments), [filaments]);
  const generatedColorTotal = clampNumber(
    processingSettings.fullSpectrumPatternCount + physicalFilamentCount,
    generatedColorBounds.minTotal,
    generatedColorBounds.maxTotal,
  );

  const baseFullSpectrumPatterns = useMemo(
    () => generateFullSpectrumPatterns(filaments, previewProcessingSettings.fullSpectrumPatternCount),
    [filaments, previewProcessingSettings.fullSpectrumPatternCount],
  );
  const fullSpectrumPatterns = useMemo(
    () => applyPatternCalibrations(baseFullSpectrumPatterns, patternCalibrations),
    [baseFullSpectrumPatterns, patternCalibrations],
  );

  const generatedPalette = useMemo(
    () => [
      ...filaments.map((filament) => filament.rgb),
      ...fullSpectrumPatterns.map((pattern) => pattern.rgb),
    ],
    [filaments, fullSpectrumPatterns],
  );

  const generatedColorTexture = useMemo(
    () => createGeneratedColorTexture(alignedCanvas, effectivePreviewProcessingSettings, generatedPalette),
    [alignedCanvas, effectivePreviewProcessingSettings, generatedPalette],
  );

  const paletteCoverageStats = useMemo(
    () =>
      calculatePaletteCoverageStats(
        generatedColorTexture.canvas,
        generatedPalette,
        filaments.length,
        fullSpectrumPatterns,
      ),
    [filaments.length, fullSpectrumPatterns, generatedColorTexture.canvas, generatedPalette],
  );

  const printedTexture = useMemo(
    () =>
      previewMode === "printed"
        ? simulateFullSpectrumPrintedTexture(
            generatedColorTexture.canvas,
            sphereSettings.diameterMm,
            sphereSettings.layerHeightMm,
            filaments,
            fullSpectrumPatterns,
          )
        : generatedColorTexture,
    [
      generatedColorTexture.canvas,
      previewMode,
      sphereSettings.diameterMm,
      sphereSettings.layerHeightMm,
      filaments,
      fullSpectrumPatterns,
    ],
  );

  const safePedestalFilamentIndex = Math.round(clampNumber(pedestalFilamentIndex, 0, Math.max(0, filaments.length - 1)));
  const pedestalColor = filaments[safePedestalFilamentIndex]?.rgb ?? { r: 220, g: 220, b: 220 };
  const activeFilamentPalette = useMemo(
    () => getActiveFilamentPalette(filaments, customPalette),
    [customPalette, filaments],
  );
  const availableGeneratedColorTotal = fullSpectrumPatterns.length + physicalFilamentCount;

  useEffect(() => {
    if (activeFilamentPalette === "custom") {
      setCustomPalette(cloneFilaments(filaments));
    }
  }, [activeFilamentPalette, filaments]);

  const previewSettings = useMemo(
    () => ({ ...sphereSettings, resolution: "standard" as const }),
    [sphereSettings],
  );
  const orientationSettings = useMemo(
    () => ({ ...sphereSettings, resolution: "draft" as const }),
    [sphereSettings],
  );
  const previewMesh = useMemo(() => generateSphereMesh(previewSettings, "full"), [previewSettings]);
  const orientationEntries = useMemo(() => createMeshEntries(orientationSettings), [orientationSettings]);

  const autoOrientation = useMemo(
    () => chooseBestOrientation(orientationEntries.map((entry) => entry.mesh), generatedColorTexture.canvas, generatedPalette),
    [generatedColorTexture.canvas, generatedPalette, orientationEntries],
  );

  const effectiveRotation = sphereSettings.orientationMode === "auto" ? autoOrientation.rotation : sphereSettings.rotationDeg;

  const showFlatPreview = previewMode !== "printed" && previewShapeView === "flat";
  const previewTexture =
    previewMode === "printed"
      ? printedTexture.canvas
      : previewMode === "generated"
          ? generatedColorTexture.canvas
          : alignedCanvas;
  const exportButtonLabel =
    exportProfile === "texture3mf" ? "Export 3MF - Image Texture" : "Export 3MF - Slicer Colors";

  async function handleUpload(file: File | undefined) {
    if (!file) {
      return;
    }

    setIsBusy(true);
    setStatus("Loading and checking panorama image...");
    try {
      console.info("[SpherePanorama] Loading image.", {
        name: file.name,
        size: file.size,
        type: file.type,
      });
      const loaded = await loadImageFile(file);
      setSourceCanvas(loaded.canvas);
      setPanoramaOffset({ x: 0, y: 0 });
      setPanoramaRotationDeg(0);
      setGuideRotationDeg(0);
      setImageInfo(loaded);
      setStatus(`Loaded ${loaded.fileName} at ${loaded.canvas.width} x ${loaded.canvas.height}.`);
    } catch (error) {
      console.error("[SpherePanorama] Image upload failed.", error);
      setStatus(error instanceof Error ? error.message : "Image upload failed.");
    } finally {
      setIsBusy(false);
    }
  }

  function updateSphere<K extends keyof SphereSettings>(key: K, value: SphereSettings[K]) {
    setSphereSettings((current) =>
      normalizeSphereSettings({ ...current, [key]: value, resolution: FILAMENT_OPTIMIZED_RESOLUTION }),
    );
  }

  function updateFilamentColors(hexes: string[]) {
    setPatternCalibrations({});
    setFilaments((current) =>
      current.map((filament, filamentIndex) =>
        updateFilamentHex(filament, hexes[filamentIndex]),
      ),
    );
  }

  function updateFilamentName(index: number, name: string) {
    setFilaments((current) =>
      current.map((filament, filamentIndex) => (filamentIndex === index ? { ...filament, name } : filament)),
    );
  }

  function setFilamentPreset(presetMode: FilamentPreset) {
    const preset = createDefaultFilaments(presetMode);
    const nextFilaments =
      activeFilamentPalette === "custom"
        ? preset
        : [
            filaments[0] ?? preset[0],
            filaments[1] ?? preset[1],
            filaments[2] ?? preset[2],
            ...preset.slice(3),
          ];
    applyFilamentPalette(nextFilaments, filaments.length);
  }

  function applyFilamentPalette(nextFilaments: FilamentChannel[], previousPhysicalCount: number) {
    setPatternCalibrations({});
    setFilaments(cloneFilaments(nextFilaments));
    setProcessingSettings((current) => {
      const currentTotal = current.fullSpectrumPatternCount + previousPhysicalCount;
      const nextBounds = getGeneratedColorBounds(nextFilaments);
      const nextTotal = clampNumber(currentTotal, nextBounds.minTotal, nextBounds.maxTotal);
      const nextPatternCount = Math.max(0, nextTotal - nextFilaments.length);
      if (current.fullSpectrumPatternCount === nextPatternCount) {
        return current;
      }

      const next = { ...current, fullSpectrumPatternCount: nextPatternCount };
      schedulePreviewUpdate(next);
      return next;
    });
  }

  function openCustomPaletteModal() {
    setCustomPaletteDraft(createEditableFilaments(customPalette ?? createDefaultFilaments("black")));
    setCustomPaletteModalOpen(true);
  }

  function updateCustomDraftName(index: number, name: string) {
    setCustomPaletteDraft((current) =>
      current.map((filament, filamentIndex) => (filamentIndex === index ? { ...filament, name } : filament)),
    );
  }

  function updateCustomDraftHex(index: number, hex: string) {
    setCustomPaletteDraft((current) =>
      current.map((filament, filamentIndex) => (filamentIndex === index ? { ...filament, hex } : filament)),
    );
  }

  function updateCustomDraftRole(index: number, role: FilamentRole) {
    setCustomPaletteDraft((current) =>
      current.map((filament, filamentIndex) => (filamentIndex === index ? { ...filament, role } : filament)),
    );
  }

  function addCustomDraftFilament() {
    setCustomPaletteDraft((current) =>
      current.length >= MAX_CUSTOM_FILAMENT_COUNT
        ? current
        : [...current, createDefaultCustomPaletteDraft()[current.length] ?? createDefaultCustomFilament(current.length)],
    );
  }

  function removeCustomDraftFilament(index: number) {
    setCustomPaletteDraft((current) =>
      current.length <= MIN_CUSTOM_FILAMENT_COUNT
        ? current
        : current
            .filter((_, filamentIndex) => filamentIndex !== index)
            .map((filament, filamentIndex) => ({ ...filament, id: `custom-draft-${filamentIndex + 1}` })),
    );
  }

  function exitCustomPaletteModal() {
    setCustomPaletteModalOpen(false);
    setCustomPaletteDraft(createEditableFilaments(customPalette ?? createDefaultFilaments("black")));
  }

  function discardCustomPaletteDraft() {
    setCustomPaletteDraft(createEditableFilaments(customPalette ?? createDefaultFilaments("black")));
    setCustomPaletteModalOpen(false);
  }

  function saveCustomPalette() {
    if (!isValidCustomPaletteDraft(customPaletteDraft)) {
      return;
    }

    const nextPalette = normalizeCustomPaletteDraft(customPaletteDraft);
    setCustomPalette(cloneFilaments(nextPalette));
    applyFilamentPalette(nextPalette, filaments.length);
    setCustomPaletteModalOpen(false);
    setStatus(`Custom filament palette saved with ${nextPalette.length} colors.`);
  }

  function autoPickCustomPaletteFromInventory() {
    if (filamentInventory.length < MIN_CUSTOM_FILAMENT_COUNT) {
      setStatus("Add at least two valid filament inventory lines before auto-picking a palette.");
      return;
    }

    const targetCount = Math.min(
      MAX_CUSTOM_FILAMENT_COUNT,
      Math.max(MIN_CUSTOM_FILAMENT_COUNT, Math.min(customPaletteDraft.length, filamentInventory.length)),
    );
    const selected = selectBestFilamentsForImage(
      alignedCanvas,
      processingSettings,
      filamentInventory,
      targetCount,
    );

    setCustomPaletteDraft(createEditableFilaments(selected));
    setStatus(`Auto-picked ${selected.length} filament colors from inventory for the current image.`);
  }

  async function importFilamentInventory(file: File | undefined) {
    if (!file) {
      return;
    }
    if (file.size > MAX_FILAMENT_INVENTORY_IMPORT_BYTES) {
      setStatus("Filament inventory import failed. Choose a TXT file smaller than 1 MB.");
      return;
    }

    try {
      const imported = parseFilamentInventory(await file.text());
      if (imported.length === 0) {
        setStatus("Filament inventory import failed. No valid lines were found. Use one color per line: Name, #RRGGBB, optional role.");
        return;
      }

      setFilamentInventoryText(formatFilamentInventory(imported));
      setStatus(`Imported ${imported.length} valid filament colors from ${file.name}.`);
    } catch (error) {
      console.error("[SpherePanorama] Could not import filament inventory.", error);
      setStatus("Filament inventory import failed. Choose an editable TXT file with one color per line.");
    }
  }

  function exportFilamentInventory() {
    if (filamentInventory.length === 0) {
      setStatus("Add at least one valid filament inventory line before exporting.");
      return;
    }

    const text = `${formatFilamentInventory(filamentInventory)}\n`;
    downloadBlob(
      new Blob([text], { type: "text/plain;charset=utf-8" }),
      `sphere_panorama_filament_inventory_${safeFileStamp()}.txt`,
    );
    setStatus(`Exported ${filamentInventory.length} filament colors as an editable TXT inventory.`);
  }

  function applySavedCustomPalette() {
    if (!customPalette) {
      return;
    }

    applyFilamentPalette(customPalette, filaments.length);
    setStatus(`Custom filament palette selected with ${customPalette.length} colors.`);
  }

  function exportProject() {
    const project: SphereProjectFile = {
      version: PROJECT_FILE_VERSION,
      sphereSettings,
      processingSettings,
      filaments,
      customPalette,
      patternCalibrations,
      pedestalFilamentIndex: safePedestalFilamentIndex,
      showAssembledPedestal,
      panoramaOffset,
      panoramaRotationDeg,
      guideRotationDeg,
      exportProfile,
      image: imageInfo
        ? {
            fileName: imageInfo.fileName,
            originalWidth: imageInfo.originalWidth,
            originalHeight: imageInfo.originalHeight,
            dataUrl: sourceCanvas.toDataURL("image/png"),
          }
        : null,
    };
    downloadBlob(
      new Blob([JSON.stringify(project, null, 2)], { type: "application/json;charset=utf-8" }),
      `sphere_panorama_project_${safeFileStamp()}.json`,
    );
    setStatus("Project saved. The JSON file includes the working panorama and current settings.");
  }

  async function importProject(file: File | undefined) {
    if (!file) {
      return;
    }
    if (file.size > MAX_PROJECT_IMPORT_BYTES) {
      setStatus("Project import failed. Choose a JSON project file smaller than 32 MB.");
      return;
    }

    setIsBusy(true);
    setStatus("Loading project...");
    try {
      const project = parseProjectFile(JSON.parse(await file.text()));
      const importedCanvas = project.image ? await dataUrlToCanvas(project.image.dataUrl) : createPlaceholderPanorama();
      const importedSettings = normalizeSphereSettings(project.sphereSettings);
      const importedProcessing = normalizeProcessingSettings(project.processingSettings, project.filaments.length);
      setSphereSettings(importedSettings);
      setProcessingSettings(importedProcessing);
      setPreviewProcessingSettings(importedProcessing);
      setFilaments(cloneFilaments(project.filaments));
      setCustomPalette(project.customPalette ? cloneFilaments(project.customPalette) : null);
      setPatternCalibrations(project.patternCalibrations);
      setPedestalFilamentIndex(clampNumber(project.pedestalFilamentIndex, 0, Math.max(0, project.filaments.length - 1)));
      setShowAssembledPedestal(project.showAssembledPedestal);
      setPanoramaOffset(project.panoramaOffset);
      setPanoramaRotationDeg(project.panoramaRotationDeg);
      setGuideRotationDeg(project.guideRotationDeg);
      setExportProfile(project.exportProfile);
      setSourceCanvas(importedCanvas);
      setImageInfo(project.image ? createLoadedImageInfo(project.image.fileName, project.image.originalWidth, project.image.originalHeight, importedCanvas) : null);
      setStatus(project.image ? `Loaded project ${file.name}.` : `Loaded project ${file.name}. Upload a panorama to enable export.`);
    } catch (error) {
      console.error("[SpherePanorama] Project import failed.", error);
      setStatus(error instanceof Error ? error.message : "Project import failed. Choose a Sphere Panorama JSON project.");
    } finally {
      setIsBusy(false);
    }
  }

  function updateRotation(axis: keyof RotationDeg, value: number) {
    setSphereSettings((current) => ({
      ...current,
      rotationDeg: {
        ...current.rotationDeg,
        [axis]: value,
      },
    }));
  }

  function rotatePreviewOnAxis(axis: PreviewLockedAxis, deltaDeg: number) {
    setPreviewRotationDeg((current) => ({
      ...current,
      [axis]: normalizeRotationDeg(current[axis] + deltaDeg),
    }));
  }

  function resetPreviewView() {
    setPreviewRotationDeg({ x: 0, y: 0, z: 0 });
    setPreviewZoom(1);
    setResetKey((key) => key + 1);
  }

  function zoomPreview(deltaY: number) {
    const direction = deltaY > 0 ? 1 : -1;
    setPreviewZoom((current) => clampNumber(current + direction * 0.08, MIN_PREVIEW_ZOOM, MAX_PREVIEW_ZOOM));
  }

  function updateProcessing<K extends keyof ProcessingSettings>(key: K, value: ProcessingSettings[K]) {
    setProcessingSettings((current) => {
      const next = { ...current, [key]: value };
      schedulePreviewUpdate(next);
      return next;
    });
  }

  function schedulePreviewUpdate(nextSettings: ProcessingSettings) {
    setIsPreviewLoading(true);
    if (previewUpdateTimerRef.current !== null) {
      window.clearTimeout(previewUpdateTimerRef.current);
    }
    if (previewLoadingFrameRef.current !== null) {
      window.cancelAnimationFrame(previewLoadingFrameRef.current);
      previewLoadingFrameRef.current = null;
    }
    if (previewLoadingHideTimerRef.current !== null) {
      window.clearTimeout(previewLoadingHideTimerRef.current);
      previewLoadingHideTimerRef.current = null;
    }
    previewUpdateTimerRef.current = window.setTimeout(() => {
      previewUpdateTimerRef.current = null;
      setPreviewProcessingSettings(nextSettings);
      previewLoadingFrameRef.current = window.requestAnimationFrame(() => {
        previewLoadingFrameRef.current = null;
        previewLoadingHideTimerRef.current = window.setTimeout(() => {
          previewLoadingHideTimerRef.current = null;
          setIsPreviewLoading(false);
        }, PREVIEW_LOADING_MIN_MS);
      });
    }, 140);
  }

  async function runExport(label: string, action: () => Promise<void>) {
    setIsBusy(true);
    setStatus(`${label}...`);
    try {
      console.info("[SpherePanorama] Export started.", {
        label,
        exportProfile,
        diameterMm: sphereSettings.diameterMm,
        layerHeightMm: sphereSettings.layerHeightMm,
        resolution: sphereSettings.resolution,
      });
      await action();
      setStatus(`${label} complete.`);
    } catch (error) {
      console.error("[SpherePanorama] Export failed.", error);
      setStatus(error instanceof Error ? error.message : `${label} failed.`);
    } finally {
      setIsBusy(false);
    }
  }

  const stamp = () => safeFileStamp();

  async function export3mf() {
    if (!imageInfo) {
      setStatus("Upload a panorama image before exporting a printable 3MF.");
      return;
    }

    await runExport(exportButtonLabel, async () => {
      await yieldToBrowser();
      const { create3mfBlob, create3mfSplitZip } = await import("./export3mf");
      const exportEntries = createMeshEntries(sphereSettings).map((entry) => ({
        ...entry,
        mesh: applyMeshRotation(entry.mesh, effectiveRotation),
      }));
      const exportKind = exportProfile === "texture3mf" ? "image_texture" : "slicer_colors";
      const exportTextureCanvas =
        exportProfile === "texture3mf"
          ? alignedCanvas
          : createGeneratedColorTexture(
              alignedCanvas,
              {
                ...processingSettings,
                fullSpectrumDiameterMm: sphereSettings.diameterMm,
                fullSpectrumLayerHeightMm: sphereSettings.layerHeightMm,
              },
              generatedPalette,
            ).canvas;
      const options = {
        filaments,
        textureCanvas: exportTextureCanvas,
        settings: sphereSettings,
        processingMode: processingSettings.mode,
        exportRotationDeg: effectiveRotation,
        textureRotationDeg: guideRotationDeg,
        pedestalColorRgb: pedestalColor,
        pedestalFilamentIndex: safePedestalFilamentIndex,
        exportProfile,
        fullSpectrumPatterns,
      };

      if (sphereSettings.splitMode === "hemispheres") {
        const blob = await create3mfSplitZip(exportEntries, options);
        downloadBlob(blob, `panorama_sphere_hemispheres_${exportKind}_3mf_${stamp()}.zip`);
      } else {
        const blob = await create3mfBlob(exportEntries, options);
        downloadBlob(blob, `panorama_sphere_${exportKind}_${stamp()}.3mf`);
      }
    });
  }

  return (
    <main className="appShell">
      <aside className="controlPanel">
        <header className="appHeader">
          <h1>3D Printable Sphere</h1>
        </header>

        <section className="panelSection">
          <SectionTitle title="Insert image" />
          <label className="uploadTarget">
            <ImageUp size={22} />
            <span>{imageInfo ? imageInfo.fileName : "Upload PNG, JPG, or WebP"}</span>
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={(event) => {
                void handleUpload(event.currentTarget.files?.[0]);
                event.currentTarget.value = "";
              }}
            />
          </label>
          <div className="metadataLine">
            {imageInfo
              ? `${imageInfo.originalWidth} x ${imageInfo.originalHeight} original, ${sourceCanvas.width} x ${sourceCanvas.height} working texture`
              : `${sourceCanvas.width} x ${sourceCanvas.height} procedural sample`}
          </div>
          {!imageInfo && <p className="hint">The procedural sample is preview-only. Upload your own panorama to enable 3MF export.</p>}
          {imageInfo && imageInfo.warnings.length > 0 && (
            <div className="inlineWarnings" role="note" aria-label="Image warnings">
              {imageInfo.warnings.map((warning) => <span key={warning}>{warning}</span>)}
            </div>
          )}
          <button className="customAlignmentButton" type="button" onClick={() => setAlignmentOpen(true)}>
            <Crosshair size={17} />
            Customize image
          </button>
        </section>

        <section className="panelSection">
          <DiameterField
            diameterMm={sphereSettings.diameterMm}
            unit={diameterUnit}
            onUnitChange={setDiameterUnit}
            onChangeMm={(value) => updateSphere("diameterMm", value)}
          />
          <NumberField
            label="Layer height"
            suffix="mm"
            min={0.04}
            max={0.6}
            step={0.02}
            value={sphereSettings.layerHeightMm}
            onChange={(value) => updateSphere("layerHeightMm", value)}
          />
        </section>

        <section className="panelSection">
          <div className="filamentTitleRow">
            <SectionTitle title="Filament colors" />
            <button
              className="iconButton"
              type="button"
              aria-label="Edit custom filament palette"
              title="Edit custom filament palette"
              onClick={openCustomPaletteModal}
            >
              <Pencil size={17} />
            </button>
          </div>
          <div className="filamentPresetStack">
            <div className="segmented threeWay" aria-label="Physical filament preset">
              <button
                type="button"
                className={activeFilamentPalette === "black" ? "active" : ""}
                onClick={() => setFilamentPreset("black")}
              >
                CMY + Black
              </button>
              <button
                type="button"
                className={activeFilamentPalette === "white" ? "active" : ""}
                onClick={() => setFilamentPreset("white")}
              >
                CMY + White
              </button>
              <button
                type="button"
                className={activeFilamentPalette === "blackWhite" ? "active" : ""}
                onClick={() => setFilamentPreset("blackWhite")}
              >
                CMY + B/W
              </button>
            </div>
            {customPalette && (
              <button
                className={`customPaletteRow ${activeFilamentPalette === "custom" ? "active" : ""}`}
                type="button"
                onClick={applySavedCustomPalette}
              >
                <span>Custom</span>
                <span className="customPaletteSwatches" aria-hidden="true">
                  {customPalette.map((filament, index) => (
                    <span
                      className="customPaletteSwatch"
                      key={`${filament.id}-${index}`}
                      style={{ backgroundColor: filament.hex }}
                    />
                  ))}
                </span>
                <strong>{customPalette.length} colors</strong>
              </button>
            )}
          </div>
          <FilamentEditor
            filaments={filaments}
            onColorsChange={updateFilamentColors}
            onNameChange={updateFilamentName}
          />
          <p className="hint">
            These measured or reference spool colors drive the slicer color map, print preview, slicer filament presets, and outside sphere paint.
          </p>
          <RangeField
            label="Generated colors"
            value={generatedColorTotal}
            min={generatedColorBounds.minTotal}
            max={generatedColorBounds.maxTotal}
            step={1}
            display={
              availableGeneratedColorTotal === generatedColorTotal
                ? `${generatedColorTotal}`
                : `${availableGeneratedColorTotal} available`
            }
            disabled={generatedColorBounds.minTotal === generatedColorBounds.maxTotal}
            onChange={(value) =>
              updateProcessing(
                "fullSpectrumPatternCount",
                Math.max(0, value - physicalFilamentCount),
              )
            }
          />
          <GeneratedColorDropdown
            filaments={filaments}
            patterns={fullSpectrumPatterns}
            physicalFilamentCount={physicalFilamentCount}
            maxPatternCount={generatedColorBounds.maxPatternCount}
            colorPercents={paletteCoverageStats.colorPercents}
            calibrationOverrides={patternCalibrations}
            onCalibrationChange={(patternId, hex) =>
              setPatternCalibrations((current) => ({ ...current, [patternId]: normalizeHex(hex) }))
            }
            onCalibrationReset={(patternId) =>
              setPatternCalibrations((current) => {
                const next = { ...current };
                delete next[patternId];
                return next;
              })
            }
          />
          <p className="estimateNote">Generated blends are visual estimates. Verify the final colors with a calibration print for your printer and filament.</p>
        </section>

        <section className="panelSection">
          <label className="toggleRow">
            <input
              type="checkbox"
              checked={sphereSettings.hollow}
              onChange={(event) => updateSphere("hollow", event.target.checked)}
            />
            <span>Hollow shell</span>
          </label>
          <NumberField
            label="Shell wall thickness"
            suffix="mm"
            min={0.8}
            max={maxWallThicknessMm(sphereSettings.diameterMm)}
            step={0.2}
            disabled={!sphereSettings.hollow}
            value={sphereSettings.wallThicknessMm}
            onChange={(value) => updateSphere("wallThicknessMm", value)}
          />
          <p className="hint">
            {sphereSettings.hollow
              ? "Hollow exports include an explicit empty cavity."
              : "Filled exports use one closed sphere volume. Choose the interior infill percentage and pattern in your slicer."}
          </p>
          <label className="field">
            <span>Flat base</span>
            <select
              value={sphereSettings.flatBase}
              onChange={(event) => updateSphere("flatBase", event.target.value as SphereSettings["flatBase"])}
            >
              <option value="none">None</option>
              <option value="small">Small flat spot</option>
              <option value="large">Larger display base</option>
              <option value="pedestal">Sphere with pedestal</option>
            </select>
          </label>
          {sphereSettings.flatBase === "pedestal" && (
            <div className="pedestalColorPanel">
              <div className="pedestalColorHeader">
                <strong>Pedestal settings</strong>
                <span style={{ backgroundColor: rgbToHex(pedestalColor) }}>{rgbToHex(pedestalColor)}</span>
              </div>
              <NumberField
                label="Pedestal width"
                suffix="mm"
                min={5}
                max={300}
                step={1}
                value={sphereSettings.pedestalWidthMm}
                onChange={(value) => updateSphere("pedestalWidthMm", value)}
              />
              <NumberField
                label="Pedestal length"
                suffix="mm"
                min={5}
                max={300}
                step={1}
                value={sphereSettings.pedestalLengthMm}
                onChange={(value) => updateSphere("pedestalLengthMm", value)}
              />
              <NumberField
                label="Pedestal height"
                suffix="mm"
                min={1}
                max={100}
                step={1}
                value={sphereSettings.pedestalHeightMm}
                onChange={(value) => updateSphere("pedestalHeightMm", value)}
              />
              <label className="field">
                <span>Pedestal filament</span>
                <select
                  value={safePedestalFilamentIndex}
                  onChange={(event) => setPedestalFilamentIndex(Number(event.target.value))}
                >
                  {filaments.map((filament, index) => (
                    <option key={filament.id} value={index}>#{index + 1} {filament.name}</option>
                  ))}
                </select>
              </label>
              <label className="toggleRow">
                <input
                  type="checkbox"
                  checked={showAssembledPedestal}
                  onChange={(event) => setShowAssembledPedestal(event.target.checked)}
                />
                <span>Show assembled pedestal preview</span>
              </label>
            </div>
          )}
          <label className="field">
            <span>Export part layout</span>
            <select
              value={sphereSettings.splitMode}
              onChange={(event) => updateSphere("splitMode", event.target.value as SphereSettings["splitMode"])}
            >
              <option value="full">Full sphere</option>
              <option value="hemispheres">Top/bottom halves</option>
            </select>
          </label>
          <label className="field">
            <span>Printing orientation</span>
            <select
              value={sphereSettings.orientationMode}
              onChange={(event) =>
                updateSphere("orientationMode", event.target.value as SphereSettings["orientationMode"])
              }
            >
              <option value="auto">Auto: fewer estimated color changes</option>
              <option value="manual">Manual XYZ rotation</option>
            </select>
            <small>
              Auto tests common 90 degree orientations and estimates color transitions by layer-like bands.
              It is a slicer-aware hint, not a replacement for checking tool changes after import.
            </small>
          </label>
          <div className="orientationSummary">
            <strong>
              {sphereSettings.orientationMode === "auto" ? autoOrientation.label : "Manual export rotation"}
            </strong>
            <span>
              X {effectiveRotation.x} deg, Y {effectiveRotation.y} deg, Z {effectiveRotation.z} deg
              {sphereSettings.orientationMode === "auto" ? `, score ${autoOrientation.score}` : ""}
            </span>
          </div>
          {sphereSettings.orientationMode === "manual" && (
            <div className="rotationGrid">
              <NumberField
                label="Rotate X"
                suffix="deg"
                min={-180}
                max={180}
                step={15}
                value={sphereSettings.rotationDeg.x}
                onChange={(value) => updateRotation("x", value)}
              />
              <NumberField
                label="Rotate Y"
                suffix="deg"
                min={-180}
                max={180}
                step={15}
                value={sphereSettings.rotationDeg.y}
                onChange={(value) => updateRotation("y", value)}
              />
              <NumberField
                label="Rotate Z"
                suffix="deg"
                min={-180}
                max={180}
                step={15}
                value={sphereSettings.rotationDeg.z}
                onChange={(value) => updateRotation("z", value)}
              />
            </div>
          )}
        </section>

        <section className="panelSection">
          <details className="advancedBlock" open={advancedOpen} onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}>
            <summary>Advanced Settings</summary>
            <RangeField
              label="Brightness"
              value={processingSettings.brightness}
              min={-50}
              max={50}
              step={1}
              display={`${processingSettings.brightness}`}
              allowManualEntry
              resetValue={defaultProcessingSettings.brightness}
              onChange={(value) => updateProcessing("brightness", value)}
              onReset={() => updateProcessing("brightness", defaultProcessingSettings.brightness)}
            />
            <RangeField
              label="Contrast"
              value={processingSettings.contrast}
              min={50}
              max={160}
              step={1}
              display={`${processingSettings.contrast}%`}
              inputSuffix="%"
              allowManualEntry
              resetValue={defaultProcessingSettings.contrast}
              onChange={(value) => updateProcessing("contrast", value)}
              onReset={() => updateProcessing("contrast", defaultProcessingSettings.contrast)}
            />
            <RangeField
              label="Saturation"
              value={processingSettings.saturation}
              min={0}
              max={200}
              step={1}
              display={`${processingSettings.saturation}%`}
              inputSuffix="%"
              allowManualEntry
              resetValue={defaultProcessingSettings.saturation}
              onChange={(value) => updateProcessing("saturation", value)}
              onReset={() => updateProcessing("saturation", defaultProcessingSettings.saturation)}
            />
            <RangeField
              label="Gamma"
              value={processingSettings.gamma}
              min={0.5}
              max={2.4}
              step={0.05}
              display={processingSettings.gamma.toFixed(2)}
              allowManualEntry
              resetValue={defaultProcessingSettings.gamma}
              onChange={(value) => updateProcessing("gamma", value)}
              onReset={() => updateProcessing("gamma", defaultProcessingSettings.gamma)}
            />
            <RangeField
              label="Sample density"
              value={processingSettings.sampleDensity}
              min={384}
              max={2048}
              step={128}
              display={`${processingSettings.sampleDensity}px`}
              inputSuffix="px"
              allowManualEntry
              resetValue={defaultProcessingSettings.sampleDensity}
              onChange={(value) => updateProcessing("sampleDensity", value)}
              onReset={() => updateProcessing("sampleDensity", defaultProcessingSettings.sampleDensity)}
            />
          </details>
        </section>
      </aside>

      <section className="workArea">
        <div className="previewToolbar">
          <div className="previewTitleGroup">
            <h2>Preview</h2>
            <button
              className={`dayNightToggle ${previewBackground}`}
              type="button"
              aria-pressed={previewBackground === "day"}
              onClick={() => setPreviewBackground((current) => (current === "day" ? "night" : "day"))}
            >
              <span className="toggleGlyph">
                {previewBackground === "day" ? <Sun size={14} /> : <Moon size={14} />}
              </span>
              <span>{previewBackground === "day" ? "Day" : "Night"}</span>
            </button>
          </div>
          <div className="previewAlignmentActions" aria-label="Image alignment actions">
            <div className="segmented threePreviewModes" aria-label="Preview mode">
              <button
                type="button"
                className={previewMode === "original" ? "active" : ""}
                onClick={() => setPreviewMode("original")}
              >
                Original sphere
              </button>
              <button
                type="button"
                className={previewMode === "generated" ? "active" : ""}
                onClick={() => setPreviewMode("generated")}
              >
                Slicer color map
              </button>
              <button
                type="button"
                className={previewMode === "printed" ? "active" : ""}
                onClick={() => {
                  setPreviewMode("printed");
                  setPreviewShapeView("ball");
                }}
              >
                Print preview
              </button>
            </div>
            <div className="previewCustomizeGroup">
              <div className="segmented viewToggle" aria-label="Preview shape">
                <button
                  type="button"
                  className={previewShapeView === "ball" ? "active" : ""}
                  onClick={() => setPreviewShapeView("ball")}
                >
                  Ball
                </button>
                <button
                  type="button"
                  className={previewShapeView === "flat" && previewMode !== "printed" ? "active" : ""}
                  onClick={() => {
                    if (previewMode === "printed") {
                      setPreviewMode("generated");
                    }
                    setPreviewShapeView("flat");
                  }}
                >
                  Flat
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className={`previewStage ${previewBackground}`}>
          {!showFlatPreview && (
            <>
              <PreviewAxisLockPanel
                axisLock={previewAxisLock}
                ballRotationDeg={effectiveRotation}
                previewRotationDeg={previewRotationDeg}
                autoSpinEnabled={autoSpinEnabled}
                autoSpinSpeed={autoSpinSpeed}
                onChange={setPreviewAxisLock}
                onAutoSpinToggle={() => setAutoSpinEnabled((current) => !current)}
                onAutoSpinSpeedChange={setAutoSpinSpeed}
              />
              <button
                className="viewportResetButton"
                type="button"
                onClick={resetPreviewView}
              >
                <RotateCcw size={17} />
                Reset view
              </button>
              <PreviewRotationDragLayer
                axisLock={previewAxisLock}
                ballRotationDeg={effectiveRotation}
                previewRotationDeg={previewRotationDeg}
                onRotate={rotatePreviewOnAxis}
                onZoom={zoomPreview}
                onFreeRotate={(deltaX, deltaY) => {
                  rotatePreviewOnAxis("z", -deltaX * PREVIEW_ROTATION_DRAG_DEG_PER_PIXEL);
                  rotatePreviewOnAxis("x", deltaY * PREVIEW_ROTATION_DRAG_DEG_PER_PIXEL);
                }}
              />
            </>
          )}
          {isPreviewLoading && <PreviewLoadingOverlay background={previewBackground} />}
          {showFlatPreview ? (
            <CanvasMapPreview textureCanvas={previewTexture} label={`${previewMode} flat preview`} />
          ) : (
            <SpherePreview
              textureCanvas={previewTexture}
              textureRotationDeg={guideRotationDeg}
              ballRotationDeg={effectiveRotation}
              resetKey={resetKey}
              background={previewBackground}
              unlit={previewMode === "generated"}
              settings={sphereSettings}
              mesh={previewMesh}
              pedestalColor={pedestalColor}
              showAssembledPedestal={showAssembledPedestal}
              previewRotationDeg={previewRotationDeg}
              previewZoom={previewZoom}
            />
          )}
        </div>

        <FilamentCoverageStrip
          filaments={filaments}
          percents={paletteCoverageStats.physicalFilamentPercents}
        />

        <div className="lowerGrid">
          <div className="statusBanner" role="status" aria-live="polite">
            {status}
          </div>
          <section className="exportPanel">
            <SectionTitle title="Export" />
            <label className="field">
              <span>3MF export target</span>
              <select
                value={exportProfile}
                onChange={(event) => setExportProfile(event.target.value as ExportProfile)}
              >
                <option value="snapmakerOrca">Snapmaker Orca slicer colors</option>
                <option value="bambuOrca">Bambu / Orca slicer colors</option>
                <option value="standard3mf">Standard 3MF color group</option>
                <option value="texture3mf">Embedded image texture</option>
              </select>
              <small>{exportProfileGuidance(exportProfile)}</small>
            </label>
            <div className="exportButtons">
              <button
                className="primaryButton"
                type="button"
                disabled={!imageInfo || isBusy || isPreviewLoading}
                title={!imageInfo ? "Upload a panorama image before exporting." : undefined}
                onClick={() => void export3mf()}
              >
                <Box size={18} />
                {exportButtonLabel}
              </button>
            </div>
          </section>
          <section className="projectPanel">
            <SectionTitle title="Project" />
            <p className="hint">Save or reopen the panorama, geometry, alignment, filament, and export settings as JSON.</p>
            <div className="projectActions">
              <button type="button" onClick={exportProject}>
                <Download size={17} />
                Save project
              </button>
              <label className="fileButton">
                <Upload size={17} />
                Load project
                <input
                  type="file"
                  accept=".json,application/json"
                  aria-label="Load Sphere Panorama JSON project"
                  onChange={(event) => {
                    void importProject(event.currentTarget.files?.[0]);
                    event.currentTarget.value = "";
                  }}
                />
              </label>
            </div>
          </section>
        </div>
      </section>
      {alignmentOpen && (
        <PanoramaAlignmentModal
          sourceCanvas={sourceCanvas}
          offset={panoramaOffset}
          rotationDeg={panoramaRotationDeg}
          guideRotationDeg={guideRotationDeg}
          onApply={(next) => {
            setPanoramaOffset(next.offset);
            setPanoramaRotationDeg(next.rotationDeg);
            setGuideRotationDeg(next.guideRotationDeg);
            setAlignmentOpen(false);
          }}
          onCancel={() => setAlignmentOpen(false)}
        />
      )}
      {customPaletteModalOpen && (
        <CustomPaletteModal
          draft={customPaletteDraft}
          canSave={isValidCustomPaletteDraft(customPaletteDraft)}
          inventoryText={filamentInventoryText}
          inventoryCount={filamentInventory.length}
          canAutoPick={filamentInventory.length >= MIN_CUSTOM_FILAMENT_COUNT}
          canExportInventory={filamentInventory.length > 0}
          onNameChange={updateCustomDraftName}
          onHexChange={updateCustomDraftHex}
          onRoleChange={updateCustomDraftRole}
          onInventoryTextChange={setFilamentInventoryText}
          onInventoryImport={importFilamentInventory}
          onInventoryExport={exportFilamentInventory}
          onAutoPick={autoPickCustomPaletteFromInventory}
          onAdd={addCustomDraftFilament}
          onRemove={removeCustomDraftFilament}
          onSave={saveCustomPalette}
          onDiscard={discardCustomPaletteDraft}
          onExit={exitCustomPaletteModal}
        />
      )}
    </main>
  );
}

function FilamentEditor({
  filaments,
  onColorsChange,
  onNameChange,
}: {
  filaments: FilamentChannel[];
  onColorsChange: (hexes: string[]) => void;
  onNameChange: (index: number, name: string) => void;
}) {
  const committedColors = filaments.map((filament) => normalizeHex(filament.hex));
  const committedColorSignature = committedColors.join("|");
  const committedNames = filaments.map((filament) => filament.name);
  const committedNameSignature = committedNames.join("|");
  const [draftColors, setDraftColors] = useState(committedColors);
  const [draftNames, setDraftNames] = useState(committedNames);
  const hasPendingColorChanges = draftColors.some((hex, index) => hex !== committedColors[index]);

  useEffect(() => {
    setDraftColors(committedColors);
  }, [committedColorSignature]);

  useEffect(() => {
    setDraftNames(committedNames);
  }, [committedNameSignature]);

  function commitName(index: number) {
    const name = draftNames[index]?.trim() || `Filament ${index + 1}`;
    setDraftNames((current) => current.map((draft, draftIndex) => (draftIndex === index ? name : draft)));
    if (name !== committedNames[index]) {
      onNameChange(index, name);
    }
  }

  return (
    <div className="filamentList">
      {filaments.map((filament, index) => (
        <div className="filamentRow" key={filament.id}>
          <span className="filamentSlotNumber" title={`Filament slot ${index + 1}`}>
            {index + 1}
          </span>
          <input
            type="color"
            value={draftColors[index] ?? filament.hex}
            aria-label={`${filament.name} color`}
            onChange={(event) =>
              setDraftColors((current) =>
                current.map((hex, colorIndex) => (colorIndex === index ? event.target.value : hex)),
              )
            }
          />
          <input
            type="text"
            value={draftNames[index] ?? filament.name}
            aria-label={`Filament ${index + 1} name`}
            onChange={(event) =>
              setDraftNames((current) =>
                current.map((name, nameIndex) => (nameIndex === index ? event.target.value : name)),
              )
            }
            onBlur={() => commitName(index)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                commitName(index);
                event.currentTarget.blur();
              }
              if (event.key === "Escape") {
                setDraftNames(committedNames);
                event.currentTarget.blur();
              }
            }}
          />
        </div>
      ))}
      <div className="filamentApplyRow">
        <span>{hasPendingColorChanges ? "Color changes are ready to preview." : "Choose colors, then update the preview."}</span>
        <button
          className="primaryButton"
          type="button"
          disabled={!hasPendingColorChanges}
          aria-label="Apply filament colors and update preview"
          onClick={() => onColorsChange(draftColors)}
        >
          OK
        </button>
      </div>
    </div>
  );
}

function CustomPaletteModal({
  draft,
  canSave,
  inventoryText,
  inventoryCount,
  canAutoPick,
  canExportInventory,
  onNameChange,
  onHexChange,
  onRoleChange,
  onInventoryTextChange,
  onInventoryImport,
  onInventoryExport,
  onAutoPick,
  onAdd,
  onRemove,
  onSave,
  onDiscard,
  onExit,
}: {
  draft: EditableFilament[];
  canSave: boolean;
  inventoryText: string;
  inventoryCount: number;
  canAutoPick: boolean;
  canExportInventory: boolean;
  onNameChange: (index: number, name: string) => void;
  onHexChange: (index: number, hex: string) => void;
  onRoleChange: (index: number, role: FilamentRole) => void;
  onInventoryTextChange: (value: string) => void;
  onInventoryImport: (file: File | undefined) => Promise<void>;
  onInventoryExport: () => void;
  onAutoPick: () => void;
  onAdd: () => void;
  onRemove: (index: number) => void;
  onSave: () => void;
  onDiscard: () => void;
  onExit: () => void;
}) {
  const modalRef = useRef<HTMLDivElement | null>(null);
  useModalAccessibility(modalRef, onExit);

  return (
    <div className="modalOverlay" role="dialog" aria-modal="true" aria-label="Custom filament palette">
      <div className="paletteModal" ref={modalRef} tabIndex={-1}>
        <div className="paletteModalHeader">
          <div>
            <strong>Custom filament palette</strong>
            <span>Keep 2 to 5 physical filament colors.</span>
          </div>
          <button className="iconButton" type="button" aria-label="Exit custom palette editor" onClick={onExit}>
            <X size={18} />
          </button>
        </div>

        <div className="paletteHelp">
          <span>Find filament hex references at</span>
          <a href="https://filamentcolors.xyz/library/" target="_blank" rel="noreferrer">
            filamentcolors.xyz/library
          </a>
        </div>

        <div className="filamentInventoryPanel">
          <div className="filamentInventoryHeader">
            <strong>Filament inventory</strong>
            <span>{inventoryCount} valid</span>
          </div>
          <small className="filamentInventoryHint">
            One color per line: Name, #RRGGBB, optional role. Roles are cyan, magenta, yellow, black, white, or custom.
          </small>
          <textarea
            value={inventoryText}
            aria-label="Filament inventory names and hex colors"
            placeholder={"One color per line:\nPLA Cyan, #00FFFF, cyan"}
            spellCheck={false}
            onChange={(event) => onInventoryTextChange(event.target.value)}
          />
          <div className="filamentInventoryActions">
            <label className="filamentInventoryImport">
              <Upload size={17} />
              Import filament list
              <input
                type="file"
                accept=".txt,.csv,text/plain,text/csv"
                aria-label="Import filament inventory TXT file"
                onChange={(event) => {
                  void onInventoryImport(event.currentTarget.files?.[0]);
                  event.currentTarget.value = "";
                }}
              />
            </label>
            <button type="button" disabled={!canExportInventory} onClick={onInventoryExport}>
              <Download size={17} />
              Export
            </button>
            <button type="button" disabled={!canAutoPick} onClick={onAutoPick}>
              <Crosshair size={17} />
              Auto-pick for image
            </button>
          </div>
        </div>

        <div className="customPaletteEditor">
          {draft.map((filament, index) => {
            const hexValid = isHexColor(filament.hex);
            return (
              <div className={`customPaletteEditRow ${hexValid ? "" : "invalid"}`} key={filament.id}>
                <input
                  type="color"
                  value={hexValid ? normalizeHex(filament.hex) : "#000000"}
                  aria-label={`Custom filament ${index + 1} color`}
                  onChange={(event) => onHexChange(index, event.target.value)}
                />
                <label>
                  <span>Name</span>
                  <input
                    type="text"
                    value={filament.name}
                    aria-label={`Custom filament ${index + 1} name`}
                    onChange={(event) => onNameChange(index, event.target.value)}
                  />
                </label>
                <label>
                  <span>Hex</span>
                  <input
                    type="text"
                    value={filament.hex}
                    aria-label={`Custom filament ${index + 1} hex color`}
                    inputMode="text"
                    spellCheck={false}
                    onChange={(event) => onHexChange(index, event.target.value)}
                    onBlur={(event) => {
                      if (isHexColor(event.target.value)) {
                        onHexChange(index, normalizeHex(event.target.value));
                      }
                    }}
                  />
                </label>
                <label>
                  <span>Role</span>
                  <select
                    value={filament.role}
                    aria-label={`Custom filament ${index + 1} role`}
                    onChange={(event) => onRoleChange(index, event.target.value as FilamentRole)}
                  >
                    <option value="custom">Custom</option>
                    <option value="cyan">Cyan</option>
                    <option value="magenta">Magenta</option>
                    <option value="yellow">Yellow</option>
                    <option value="black">Black</option>
                    <option value="white">White</option>
                  </select>
                </label>
                <button
                  className="iconButton"
                  type="button"
                  aria-label={`Remove custom filament ${index + 1}`}
                  disabled={draft.length <= MIN_CUSTOM_FILAMENT_COUNT}
                  onClick={() => onRemove(index)}
                >
                  <Minus size={17} />
                </button>
              </div>
            );
          })}
        </div>

        <div className="paletteModalControls">
          <button
            type="button"
            disabled={draft.length >= MAX_CUSTOM_FILAMENT_COUNT}
            onClick={onAdd}
          >
            <Plus size={17} />
            Add color
          </button>
          <span>{draft.length} / {MAX_CUSTOM_FILAMENT_COUNT}</span>
        </div>

        <div className="paletteModalFooter">
          <button type="button" onClick={onDiscard}>
            Discard
          </button>
          <button type="button" onClick={onExit}>
            Exit
          </button>
          <button className="primaryButton" type="button" disabled={!canSave} onClick={onSave}>
            <Save size={17} />
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

function GeneratedColorDropdown({
  filaments,
  patterns,
  physicalFilamentCount,
  maxPatternCount,
  colorPercents,
  calibrationOverrides,
  onCalibrationChange,
  onCalibrationReset,
}: {
  filaments: FilamentChannel[];
  patterns: FullSpectrumPattern[];
  physicalFilamentCount: number;
  maxPatternCount: number;
  colorPercents: number[];
  calibrationOverrides: Record<string, string>;
  onCalibrationChange: (patternId: string, hex: string) => void;
  onCalibrationReset: (patternId: string) => void;
}) {
  const rows = [
    ...filaments.map((filament, index) => ({
      id: filament.id,
      slot: index + 1,
      hex: filament.hex,
      recipe: `${index + 1}`,
      percent: colorPercents[index] ?? 0,
      tooltip: `Filament ${index + 1}: ${filament.name}`,
      patternId: null,
      calibrated: false,
    })),
    ...patterns.map((pattern, index) => {
      const slot = index + physicalFilamentCount + 1;
      const componentA = filaments[pattern.componentA - 1]?.name ?? `Filament ${pattern.componentA}`;
      const componentB = filaments[pattern.componentB - 1]?.name ?? `Filament ${pattern.componentB}`;
      const componentAPercent = 100 - pattern.mixBPercent;
      return {
        id: pattern.id,
        slot,
        hex: pattern.hex,
        recipe: pattern.expandedPattern,
        percent: colorPercents[slot - 1] ?? 0,
        tooltip: [
          `Filament ${pattern.componentA}: ${componentA} (${componentAPercent}%)`,
          `Filament ${pattern.componentB}: ${componentB} (${pattern.mixBPercent}%)`,
          `Slicer pair recipe: ${pattern.manualPattern}`,
        ].join("\n"),
        patternId: pattern.id,
        calibrated: Boolean(calibrationOverrides[pattern.id]),
      };
    }),
  ];

  return (
    <details className="generatedColorDropdown">
      <summary>
        <span>Generated color list <em className="estimateBadge">Estimated</em></span>
        <strong>{patterns.length + physicalFilamentCount}</strong>
      </summary>
      <p className="generatedColorNote">
        {patterns.length} generated blends available from {physicalFilamentCount} physical colors
        {patterns.length < maxPatternCount ? `, up to ${maxPatternCount} supported` : ""}.
        Set a generated row's calibration swatch after a physical test print to replace its estimate.
      </p>
      <div className="generatedColorList">
        <div className="generatedColorHeader" aria-hidden="true">
          <span />
          <span>#</span>
          <span>Hex</span>
          <span>Recipe</span>
          <span>%</span>
          <span>Calibration</span>
        </div>
        {rows.map((row) => (
          <div className="generatedColorRow" key={row.id}>
            <span className="generatedColorSwatch" style={{ backgroundColor: row.hex }} />
            <span className="generatedColorIndex">#{row.slot}</span>
            <code>{row.hex}</code>
            <span className="generatedColorRecipe" title={row.tooltip}>
              <code>{row.recipe}</code>
            </span>
            <span className="generatedColorPercent">{formatCoveragePercent(row.percent)}</span>
            {row.patternId ? (
              <span className="generatedColorCalibration">
                <input
                  type="color"
                  value={row.hex}
                  aria-label={`Measured calibration color for ${row.tooltip}`}
                  title={row.calibrated ? "Measured calibration color" : "Set measured calibration color"}
                  onChange={(event) => onCalibrationChange(row.patternId as string, event.target.value)}
                />
                <button
                  type="button"
                  disabled={!row.calibrated}
                  aria-label={`Reset estimated color for ${row.tooltip}`}
                  title="Reset to estimated color"
                  onClick={() => onCalibrationReset(row.patternId as string)}
                >
                  <RotateCcw size={12} />
                </button>
              </span>
            ) : (
              <span className="physicalColorLabel">Spool</span>
            )}
          </div>
        ))}
      </div>
    </details>
  );
}

function FilamentCoverageStrip({
  filaments,
  percents,
}: {
  filaments: FilamentChannel[];
  percents: number[];
}) {
  return (
    <section className="filamentCoverageStrip" aria-label="Physical filament surface coverage">
      {filaments.map((filament, index) => (
        <div className="coveragePill" key={filament.id} title={filament.name}>
          <span className="coverageSwatch" style={{ backgroundColor: filament.hex }} />
          <strong>#{index + 1}</strong>
          <span>{formatCoveragePercent(percents[index] ?? 0)}</span>
        </div>
      ))}
    </section>
  );
}

function PreviewAxisLockPanel({
  axisLock,
  ballRotationDeg,
  previewRotationDeg,
  autoSpinEnabled,
  autoSpinSpeed,
  onChange,
  onAutoSpinToggle,
  onAutoSpinSpeedChange,
}: {
  axisLock: PreviewAxisLock;
  ballRotationDeg: RotationDeg;
  previewRotationDeg: RotationDeg;
  autoSpinEnabled: boolean;
  autoSpinSpeed: number;
  onChange: (axisLock: PreviewAxisLock) => void;
  onAutoSpinToggle: () => void;
  onAutoSpinSpeedChange: (speed: number) => void;
}) {
  const stateLabel = axisLock === "free" ? "Free" : `Locked ${axisLock.toUpperCase()}`;
  const axes = useMemo(
    () => createPreviewAxisProjection(ballRotationDeg, previewRotationDeg),
    [
      ballRotationDeg.x,
      ballRotationDeg.y,
      ballRotationDeg.z,
      previewRotationDeg.x,
      previewRotationDeg.y,
      previewRotationDeg.z,
    ],
  );

  return (
    <div className="axisLockPanel" aria-label={`Preview axis lock: ${stateLabel}`} title={stateLabel}>
      <svg className="axisGizmo" viewBox="0 0 72 72" aria-hidden="true" focusable="false">
        <line className="axisLine axisX" x1={axes.origin.x} y1={axes.origin.y} x2={axes.x.end.x} y2={axes.x.end.y} />
        <circle className="axisDot axisX" cx={axes.x.end.x} cy={axes.x.end.y} r="3" />
        <text className="axisText axisX" x={axes.x.label.x} y={axes.x.label.y} textAnchor="middle" dominantBaseline="middle">
          X
        </text>
        <line className="axisLine axisY" x1={axes.origin.x} y1={axes.origin.y} x2={axes.y.end.x} y2={axes.y.end.y} />
        <circle className="axisDot axisY" cx={axes.y.end.x} cy={axes.y.end.y} r="3" />
        <text className="axisText axisY" x={axes.y.label.x} y={axes.y.label.y} textAnchor="middle" dominantBaseline="middle">
          Y
        </text>
        <line className="axisLine axisZ" x1={axes.origin.x} y1={axes.origin.y} x2={axes.z.end.x} y2={axes.z.end.y} />
        <circle className="axisDot axisZ" cx={axes.z.end.x} cy={axes.z.end.y} r="3" />
        <text className="axisText axisZ" x={axes.z.label.x} y={axes.z.label.y} textAnchor="middle" dominantBaseline="middle">
          Z
        </text>
        <circle className="axisOrigin" cx={axes.origin.x} cy={axes.origin.y} r="4" />
      </svg>
      <div className="axisLockBody">
        <div className="axisLockButtons">
          {PREVIEW_AXIS_LOCK_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`axisLockButton ${axisLock === option.value ? "active" : ""}`}
              data-axis={option.value}
              aria-pressed={axisLock === option.value}
              onClick={() => onChange(option.value)}
            >
              {option.label}
            </button>
          ))}
          <button
            type="button"
            className={`axisLockButton autoSpinButton ${autoSpinEnabled ? "active" : ""}`}
            aria-pressed={autoSpinEnabled}
            aria-label="Auto spin"
            title="Auto spin"
            onClick={onAutoSpinToggle}
          >
            <RotateCw size={12} />
          </button>
        </div>
        {autoSpinEnabled && (
          <label className="axisSpinSpeed">
            <input
              type="range"
              min={MIN_AUTO_SPIN_SPEED}
              max={MAX_AUTO_SPIN_SPEED}
              step={0.01}
              value={autoSpinSpeed}
              aria-label="Auto spin speed"
              onChange={(event) => onAutoSpinSpeedChange(Number(event.target.value))}
            />
            <strong>{(autoSpinSpeed / DEFAULT_AUTO_SPIN_SPEED).toFixed(2)}x</strong>
          </label>
        )}
      </div>
    </div>
  );
}

function PreviewRotationDragLayer({
  axisLock,
  ballRotationDeg,
  previewRotationDeg,
  onRotate,
  onZoom,
  onFreeRotate,
}: {
  axisLock: PreviewAxisLock;
  ballRotationDeg: RotationDeg;
  previewRotationDeg: RotationDeg;
  onRotate: (axis: PreviewLockedAxis, deltaDeg: number) => void;
  onZoom: (deltaY: number) => void;
  onFreeRotate: (deltaX: number, deltaY: number) => void;
}) {
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const layerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) {
      return;
    }

    function handleNativeWheel(event: globalThis.WheelEvent) {
      event.preventDefault();
      event.stopPropagation();
      onZoom(event.deltaY);
    }

    layer.addEventListener("wheel", handleNativeWheel, { passive: false });
    return () => layer.removeEventListener("wheel", handleNativeWheel);
  }, [onZoom]);

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    lastPointRef.current = { x: event.clientX, y: event.clientY };
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!lastPointRef.current) {
      return;
    }

    const deltaX = event.clientX - lastPointRef.current.x;
    const deltaY = event.clientY - lastPointRef.current.y;
    if (axisLock === "free") {
      onFreeRotate(deltaX, deltaY);
    } else {
      const movement = getPreviewLockedAxisDragMovement(
        axisLock,
        ballRotationDeg,
        previewRotationDeg,
        deltaX,
        deltaY,
      );
      onRotate(axisLock, movement * PREVIEW_ROTATION_DRAG_DEG_PER_PIXEL);
    }
    lastPointRef.current = { x: event.clientX, y: event.clientY };
  }

  function handlePointerUp(event: PointerEvent<HTMLDivElement>) {
    lastPointRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const amount = event.shiftKey ? 15 : 5;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      onRotate(axisLock === "free" ? "z" : axisLock, event.key === "ArrowLeft" ? -amount : amount);
    }
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      onRotate(axisLock === "free" ? "x" : axisLock, event.key === "ArrowUp" ? -amount : amount);
    }
    if (event.key === "+" || event.key === "=" || event.key === "-") {
      event.preventDefault();
      onZoom(event.key === "-" ? 1 : -1);
    }
  }

  return (
    <div
      ref={layerRef}
      className={`previewRotationDragLayer ${axisLock}`}
      tabIndex={0}
      role="application"
      aria-label="Interactive sphere preview. Use arrow keys to rotate, plus and minus to zoom."
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onKeyDown={handleKeyDown}
    />
  );
}

function PreviewLoadingOverlay({ background }: { background: PreviewBackground }) {
  return (
    <div className={`previewLoadingOverlay ${background}`} role="status" aria-label="Generating preview colors">
      <span className="loadingSpinner" aria-hidden="true" />
    </div>
  );
}

function SpherePreview({
  textureCanvas,
  textureRotationDeg,
  ballRotationDeg,
  resetKey,
  background,
  unlit,
  settings,
  mesh,
  pedestalColor,
  showAssembledPedestal,
  previewRotationDeg,
  previewZoom,
}: {
  textureCanvas: HTMLCanvasElement;
  textureRotationDeg: number;
  ballRotationDeg: RotationDeg;
  resetKey: number;
  background: PreviewBackground;
  unlit: boolean;
  settings: SphereSettings;
  mesh: SphereMesh;
  pedestalColor: Rgb;
  showAssembledPedestal: boolean;
  previewRotationDeg: RotationDeg;
  previewZoom: number;
}) {
  const isDay = background === "day";
  const cameraDistance = 3.25 * previewZoom;

  return (
    <Canvas
      camera={{ position: [0, 0.2, cameraDistance], fov: 42 }}
      dpr={[1, 2]}
      onCreated={({ gl }) => {
        console.info("[SpherePanorama] 3D preview initialized.", {
          renderer: gl.getContext().getParameter(gl.getContext().RENDERER),
          vendor: gl.getContext().getParameter(gl.getContext().VENDOR),
        });
      }}
    >
      <color attach="background" args={[isDay ? "#edf4f0" : "#101816"]} />
      <ambientLight intensity={isDay ? 1.35 : 1.05} />
      <directionalLight position={[3, 3, 4]} intensity={isDay ? 1.65 : 1.85} />
      <directionalLight position={[-4, -2, -3]} intensity={isDay ? 0.62 : 0.42} />
      <PreviewCameraZoom distance={cameraDistance} />
      <PreviewRotatedTexturedSphere
        textureCanvas={textureCanvas}
        textureRotationDeg={textureRotationDeg}
        ballRotationDeg={ballRotationDeg}
        mesh={mesh}
        previewRotationDeg={previewRotationDeg}
        unlit={unlit}
        position={settings.flatBase === "pedestal" && !showAssembledPedestal ? [-0.95, 0.12, 0] : [0, 0, 0]}
      />
      {settings.flatBase === "pedestal" && (
        <PedestalPreview
          settings={settings}
          color={pedestalColor}
          position={showAssembledPedestal ? assembledPedestalPreviewPosition(settings) : [1.35, -0.72, 0]}
        />
      )}
      <OrbitReset resetKey={resetKey} />
    </Canvas>
  );
}

function PreviewCameraZoom({ distance }: { distance: number }) {
  const { camera } = useThree();

  useEffect(() => {
    camera.position.set(0, 0.2, distance);
    camera.updateProjectionMatrix();
  }, [camera, distance]);

  return null;
}

function CanvasMapPreview({ textureCanvas, label }: { textureCanvas: HTMLCanvasElement; label: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    canvas.width = textureCanvas.width;
    canvas.height = textureCanvas.height;
    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }

    context.clearRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingEnabled = false;
    context.drawImage(textureCanvas, 0, 0);
  }, [textureCanvas]);

  return (
    <div className="photoPreview">
      <canvas ref={canvasRef} role="img" aria-label={label} />
    </div>
  );
}

function PreviewRotatedTexturedSphere({
  textureCanvas,
  textureRotationDeg,
  ballRotationDeg,
  mesh,
  previewRotationDeg,
  unlit,
  position,
}: {
  textureCanvas: HTMLCanvasElement;
  textureRotationDeg: number;
  ballRotationDeg: RotationDeg;
  mesh: SphereMesh;
  previewRotationDeg: RotationDeg;
  unlit: boolean;
  position: [number, number, number];
}) {
  const previewRotation = useMemo<[number, number, number]>(
    () => previewRotationDegToEulerTuple(previewRotationDeg),
    [previewRotationDeg.x, previewRotationDeg.y, previewRotationDeg.z],
  );

  return (
    <group rotation={previewRotation} position={position}>
      <TexturedSphere
        textureCanvas={textureCanvas}
        textureRotationDeg={textureRotationDeg}
        ballRotationDeg={ballRotationDeg}
        mesh={mesh}
        unlit={unlit}
        position={[0, 0, 0]}
      />
    </group>
  );
}

function TexturedSphere({
  textureCanvas,
  textureRotationDeg,
  ballRotationDeg,
  mesh,
  unlit,
  position,
}: {
  textureCanvas: HTMLCanvasElement;
  textureRotationDeg: number;
  ballRotationDeg: RotationDeg;
  mesh: SphereMesh;
  unlit: boolean;
  position: [number, number, number];
}) {
  const geometry = useMemo(() => {
    return createPreviewGeometry(mesh, textureRotationDeg);
  }, [mesh, textureRotationDeg]);

  useEffect(() => {
    return () => geometry.dispose();
  }, [geometry]);

  const texture = useMemo(() => {
    const canvasTexture = new THREE.CanvasTexture(textureCanvas);
    canvasTexture.colorSpace = THREE.SRGBColorSpace;
    canvasTexture.wrapS = THREE.RepeatWrapping;
    canvasTexture.wrapT = THREE.ClampToEdgeWrapping;
    canvasTexture.anisotropy = 8;
    canvasTexture.needsUpdate = true;
    return canvasTexture;
  }, [textureCanvas]);

  useEffect(() => () => texture.dispose(), [texture]);

  const meshRotation = useMemo<[number, number, number]>(
    () => [
      degreesToRadians(ballRotationDeg.x),
      -Math.PI / 2 + degreesToRadians(ballRotationDeg.y),
      degreesToRadians(ballRotationDeg.z),
    ],
    [ballRotationDeg.x, ballRotationDeg.y, ballRotationDeg.z],
  );

  return (
    <mesh rotation={meshRotation} position={position}>
      <primitive attach="geometry" object={geometry} />
      {unlit ? (
        <meshBasicMaterial map={texture} toneMapped={false} />
      ) : (
        <meshStandardMaterial map={texture} roughness={0.82} metalness={0.02} />
      )}
    </mesh>
  );
}

function previewRotationDegToEulerTuple(rotationDeg: RotationDeg): [number, number, number] {
  // The viewport controls are Z-up; Three.js is Y-up, so UI Y and Z are intentionally remapped here.
  return [
    degreesToRadians(rotationDeg.x),
    degreesToRadians(rotationDeg.z),
    degreesToRadians(rotationDeg.y),
  ];
}

function createPreviewAxisProjection(ballRotationDeg: RotationDeg, previewRotationDeg: RotationDeg) {
  const origin = { x: 34, y: 40 };
  const previewRotation = previewRotationDegToEulerTuple(previewRotationDeg);
  const previewQuaternion = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(previewRotation[0], previewRotation[1], previewRotation[2], "XYZ"),
  );
  const meshQuaternion = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(
      degreesToRadians(ballRotationDeg.x),
      -Math.PI / 2 + degreesToRadians(ballRotationDeg.y),
      degreesToRadians(ballRotationDeg.z),
      "XYZ",
    ),
  );
  const totalQuaternion = previewQuaternion.multiply(meshQuaternion);

  return {
    origin,
    x: projectPreviewAxis(new THREE.Vector3(1, 0, 0), totalQuaternion, origin),
    y: projectPreviewAxis(new THREE.Vector3(0, 0, 1), totalQuaternion, origin),
    z: projectPreviewAxis(new THREE.Vector3(0, 1, 0), totalQuaternion, origin),
  };
}

function getPreviewLockedAxisDragMovement(
  axis: PreviewLockedAxis,
  ballRotationDeg: RotationDeg,
  previewRotationDeg: RotationDeg,
  deltaX: number,
  deltaY: number,
): number {
  const axes = createPreviewAxisProjection(ballRotationDeg, previewRotationDeg);
  const selectedAxis = axes[axis];
  const projectedAxis = new THREE.Vector2(
    selectedAxis.end.x - axes.origin.x,
    selectedAxis.end.y - axes.origin.y,
  );

  if (projectedAxis.lengthSq() < 0.0001) {
    projectedAxis.set(axis === "z" ? 0 : -1, axis === "z" ? -1 : 0);
  }

  projectedAxis.normalize();
  const dragTangent = new THREE.Vector2(projectedAxis.y, -projectedAxis.x);
  return deltaX * dragTangent.x + deltaY * dragTangent.y;
}

function projectPreviewAxis(
  axis: THREE.Vector3,
  rotation: THREE.Quaternion,
  origin: { x: number; y: number },
): { end: { x: number; y: number }; label: { x: number; y: number } } {
  const rotated = axis.applyQuaternion(rotation).normalize();
  const projected = new THREE.Vector2(rotated.x - rotated.z * 0.56, -rotated.y + rotated.z * 0.42);
  if (projected.lengthSq() < 0.0001) {
    projected.set(0.01, -1);
  }
  projected.normalize();

  return {
    end: {
      x: origin.x + projected.x * 20,
      y: origin.y + projected.y * 20,
    },
    label: {
      x: clampNumber(origin.x + projected.x * 29, 6, 66),
      y: clampNumber(origin.y + projected.y * 29, 8, 66),
    },
  };
}

function createPreviewGeometry(mesh: SphereMesh, textureRotationDeg: number): THREE.BufferGeometry {
  const scale = 2.7 / Math.max(1, mesh.settings.diameterMm);
  const geometry = new THREE.BufferGeometry();
  const positions = mesh.vertices.flatMap((vertex) => [vertex.x * scale, vertex.y * scale, vertex.z * scale]);
  const uvs = mesh.vertices.flatMap((vertex) => {
    const transformed = transformTextureUv({ u: vertex.u, v: 1 - vertex.v }, textureRotationDeg);
    return [transformed.u, transformed.v];
  });
  const indices = mesh.triangles
    .filter((triangle) => triangle.surface !== "inner")
    .flatMap((triangle) => [triangle.a, triangle.b, triangle.c]);
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function assembledPedestalPreviewPosition(settings: SphereSettings): [number, number, number] {
  const scale = 2.7 / Math.max(1, settings.diameterMm);
  return [0, -1.35 + (settings.pedestalHeightMm * scale) / 2, 0];
}

function PedestalPreview({
  settings,
  color,
  position,
}: {
  settings: SphereSettings;
  color: Rgb;
  position: [number, number, number];
}) {
  const scale = 2.7 / Math.max(1, settings.diameterMm);
  return (
    <mesh position={position}>
      <boxGeometry
        args={[
          Math.max(0.12, settings.pedestalWidthMm * scale),
          Math.max(0.08, settings.pedestalHeightMm * scale),
          Math.max(0.12, settings.pedestalLengthMm * scale),
        ]}
      />
      <meshBasicMaterial color={rgbToHex(color)} toneMapped={false} />
    </mesh>
  );
}

function OrbitReset({ resetKey }: { resetKey: number }) {
  const controlsRef = useRef<any>(null);

  useEffect(() => {
    controlsRef.current?.reset();
  }, [resetKey]);

  return (
    <OrbitControls
      ref={controlsRef}
      enableDamping
      dampingFactor={0.08}
      enableRotate={false}
      enablePan={false}
      minDistance={2.15}
      maxDistance={5.5}
    />
  );
}

function SectionTitle({ title }: { title: string }) {
  return <h2 className="sectionTitle">{title}</h2>;
}

function useModalAccessibility(modalRef: RefObject<HTMLElement | null>, onEscape: () => void) {
  const onEscapeRef = useRef(onEscape);

  useEffect(() => {
    onEscapeRef.current = onEscape;
  }, [onEscape]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const modal = modalRef.current;
    if (!modal) {
      return;
    }

    const focusableSelector = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])';
    const focusable = () => [...modal.querySelectorAll<HTMLElement>(focusableSelector)];
    (focusable()[0] ?? modal).focus();

    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onEscapeRef.current();
        return;
      }
      if (event.key !== "Tab") {
        return;
      }

      const controls = focusable();
      if (controls.length === 0) {
        event.preventDefault();
        modalRef.current?.focus();
        return;
      }
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previousFocus?.focus();
    };
  }, [modalRef]);
}

function PanoramaAlignmentModal({
  sourceCanvas,
  offset,
  rotationDeg,
  guideRotationDeg,
  onApply,
  onCancel,
}: {
  sourceCanvas: HTMLCanvasElement;
  offset: PanoramaOffset;
  rotationDeg: number;
  guideRotationDeg: number;
  onApply: (draft: { offset: PanoramaOffset; rotationDeg: number; guideRotationDeg: number }) => void;
  onCancel: () => void;
}) {
  const modalRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const offsetRef = useRef(offset);
  const rotationRef = useRef(rotationDeg);
  const guideRotationRef = useRef(guideRotationDeg);
  const frameRef = useRef<number | null>(null);
  useModalAccessibility(modalRef, onCancel);

  useEffect(() => {
    offsetRef.current = offset;
    rotationRef.current = rotationDeg;
    guideRotationRef.current = guideRotationDeg;
  }, [guideRotationDeg, offset, rotationDeg]);

  function renderAlignment(nextOffset: PanoramaOffset) {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }

    const aligned = wrapPanoramaCanvas(sourceCanvas, nextOffset.x, nextOffset.y, rotationRef.current);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(aligned, 0, 0, canvas.width, canvas.height);
    drawAlignmentGuides(context, canvas.width, canvas.height, guideRotationRef.current);
  }

  function scheduleRender() {
    if (frameRef.current !== null) {
      return;
    }
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      renderAlignment(offsetRef.current);
    });
  }

  useEffect(() => {
    renderAlignment(offsetRef.current);
    return () => {
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
      }
    };
  }, [sourceCanvas]);

  function handlePointerDown(event: PointerEvent<HTMLCanvasElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    lastPointRef.current = { x: event.clientX, y: event.clientY };
  }

  function handlePointerMove(event: PointerEvent<HTMLCanvasElement>) {
    if (!lastPointRef.current) {
      return;
    }

    const rect = event.currentTarget.getBoundingClientRect();
    const deltaX = (event.clientX - lastPointRef.current.x) / Math.max(1, rect.width);
    const deltaY = (event.clientY - lastPointRef.current.y) / Math.max(1, rect.height);
    const next = {
      x: normalizeOffset(offsetRef.current.x + deltaX),
      y: normalizeOffset(offsetRef.current.y + deltaY),
    };
    offsetRef.current = next;
    lastPointRef.current = { x: event.clientX, y: event.clientY };
    scheduleRender();
  }

  function handlePointerUp(event: PointerEvent<HTMLCanvasElement>) {
    lastPointRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function resetAlignment() {
    const next = { x: 0, y: 0 };
    offsetRef.current = next;
    rotationRef.current = 0;
    guideRotationRef.current = 0;
    renderAlignment(next);
  }

  function rotatePictureBy90() {
    rotationRef.current = (rotationRef.current + 90) % 360;
    const nextOffset = { x: 0, y: 0 };
    offsetRef.current = nextOffset;
    renderAlignment(nextOffset);
  }

  function rotateGuidesBy90() {
    guideRotationRef.current = (guideRotationRef.current + 90) % 360;
    renderAlignment(offsetRef.current);
  }

  function applyAndClose() {
    onApply({
      offset: offsetRef.current,
      rotationDeg: rotationRef.current,
      guideRotationDeg: guideRotationRef.current,
    });
  }

  return (
    <div className="modalOverlay" role="dialog" aria-modal="true" aria-label="Image and ball customization">
      <div className="alignmentModal" ref={modalRef} tabIndex={-1}>
        <div className="alignmentHeader">
          <div>
            <strong>Image / ball customization</strong>
            <span>Drag the panorama behind the equator and prime meridian guides.</span>
          </div>
          <div className="modalActions">
            <button type="button" onClick={rotatePictureBy90}>
              Rotate picture 90 deg
            </button>
            <button type="button" onClick={rotateGuidesBy90}>
              Rotate guides 90 deg
            </button>
            <button type="button" onClick={resetAlignment}>
              Reset
            </button>
            <button type="button" onClick={onCancel}>
              Cancel
            </button>
            <button type="button" onClick={applyAndClose}>
              Done
            </button>
          </div>
        </div>
        <div className="alignmentControl">
          <canvas
            ref={canvasRef}
            width={960}
            height={480}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
          />
          <p className="hint">
            The image loops in both directions, so the rectangle never goes blank. Preview and export update when you click Done.
          </p>
        </div>
      </div>
    </div>
  );
}

function drawAlignmentGuides(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  guideRotationDeg: number,
): void {
  const rotated = normalizeRightAngle(guideRotationDeg) === 90 || normalizeRightAngle(guideRotationDeg) === 270;
  const primeLine = rotated
    ? { x1: 0, y1: height / 2, x2: width, y2: height / 2 }
    : { x1: width / 2, y1: 0, x2: width / 2, y2: height };
  const equatorLine = rotated
    ? { x1: width / 2, y1: 0, x2: width / 2, y2: height }
    : { x1: 0, y1: height / 2, x2: width, y2: height / 2 };

  context.lineWidth = 2;
  context.setLineDash([7, 5]);
  context.strokeStyle = "rgba(87, 196, 255, 0.9)";
  context.beginPath();
  context.moveTo(primeLine.x1, primeLine.y1);
  context.lineTo(primeLine.x2, primeLine.y2);
  context.stroke();
  context.strokeStyle = "rgba(255, 222, 112, 0.9)";
  context.beginPath();
  context.moveTo(equatorLine.x1, equatorLine.y1);
  context.lineTo(equatorLine.x2, equatorLine.y2);
  context.stroke();
  context.setLineDash([]);

  context.fillStyle = "rgba(0, 0, 0, 0.62)";
  context.fillRect(10, 10, 206, 58);
  context.font = "700 13px system-ui, sans-serif";
  context.fillStyle = "#57c4ff";
  context.fillText("Prime meridian", rotated ? 22 : width / 2 + 8, rotated ? height / 2 - 8 : 24);
  context.fillStyle = "#ffde70";
  context.fillText("Equator", rotated ? width / 2 + 8 : 22, rotated ? 24 : height / 2 - 8);
  context.fillStyle = "#ffffff";
  context.font = "12px system-ui, sans-serif";
  context.fillText("Drag image to align", 22, 42);
  context.fillText(`Guide rotation ${normalizeRightAngle(guideRotationDeg)} deg`, 22, 60);
}

function normalizeOffset(value: number): number {
  return ((value % 1) + 1) % 1;
}

function normalizeRotationDeg(value: number): number {
  const normalized = ((value % 360) + 360) % 360;
  return normalized > 180 ? normalized - 360 : normalized;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function maxWallThicknessMm(diameterMm: number): number {
  return Math.max(0.8, diameterMm / 2 - 0.5);
}

function normalizeSphereSettings(settings: SphereSettings): SphereSettings {
  const diameterMm = clampFiniteNumber(settings.diameterMm, 20, 300, defaultSphereSettings.diameterMm);
  return {
    ...defaultSphereSettings,
    ...settings,
    diameterMm,
    resolution: FILAMENT_OPTIMIZED_RESOLUTION,
    hollow: Boolean(settings.hollow),
    wallThicknessMm: clampFiniteNumber(settings.wallThicknessMm, 0.8, maxWallThicknessMm(diameterMm), defaultSphereSettings.wallThicknessMm),
    layerHeightMm: clampFiniteNumber(settings.layerHeightMm, 0.04, 0.6, defaultSphereSettings.layerHeightMm),
    flatBase: isFlatBaseMode(settings.flatBase) ? settings.flatBase : defaultSphereSettings.flatBase,
    pedestalWidthMm: clampFiniteNumber(settings.pedestalWidthMm, 5, 300, defaultSphereSettings.pedestalWidthMm),
    pedestalLengthMm: clampFiniteNumber(settings.pedestalLengthMm, 5, 300, defaultSphereSettings.pedestalLengthMm),
    pedestalHeightMm: clampFiniteNumber(settings.pedestalHeightMm, 1, 100, defaultSphereSettings.pedestalHeightMm),
    splitMode: settings.splitMode === "hemispheres" ? "hemispheres" : "full",
    orientationMode: settings.orientationMode === "manual" ? "manual" : "auto",
    rotationDeg: {
      x: clampFiniteNumber(settings.rotationDeg?.x, -180, 180, 0),
      y: clampFiniteNumber(settings.rotationDeg?.y, -180, 180, 0),
      z: clampFiniteNumber(settings.rotationDeg?.z, -180, 180, 0),
    },
  };
}

function normalizeProcessingSettings(settings: ProcessingSettings, physicalFilamentCount: number): ProcessingSettings {
  return {
    ...defaultProcessingSettings,
    ...settings,
    mode: settings.mode === "nearest" || settings.mode === "fullTexture" ? settings.mode : "dither",
    brightness: clampFiniteNumber(settings.brightness, -50, 50, defaultProcessingSettings.brightness),
    contrast: clampFiniteNumber(settings.contrast, 50, 160, defaultProcessingSettings.contrast),
    saturation: clampFiniteNumber(settings.saturation, 0, 200, defaultProcessingSettings.saturation),
    gamma: clampFiniteNumber(settings.gamma, 0.5, 2.4, defaultProcessingSettings.gamma),
    ditherStrength: clampFiniteNumber(settings.ditherStrength, 0, 1, defaultProcessingSettings.ditherStrength),
    fullSpectrumComboColors: clampFiniteNumber(settings.fullSpectrumComboColors, 0, 120, defaultProcessingSettings.fullSpectrumComboColors),
    fullSpectrumPatternCount: clampFiniteNumber(
      settings.fullSpectrumPatternCount,
      0,
      Math.max(0, MAX_TOTAL_COLOR_COUNT - physicalFilamentCount),
      Math.max(0, MIN_TOTAL_COLOR_COUNT - physicalFilamentCount),
    ),
    sampleDensity: clampFiniteNumber(settings.sampleDensity, 384, 2048, defaultProcessingSettings.sampleDensity),
  };
}

function clampFiniteNumber(value: number | undefined, min: number, max: number, fallback: number): number {
  return Number.isFinite(value) ? clampNumber(value as number, min, max) : fallback;
}

function isFlatBaseMode(value: unknown): value is SphereSettings["flatBase"] {
  return value === "none" || value === "small" || value === "large" || value === "pedestal";
}

function degreesToRadians(value: number): number {
  return (value * Math.PI) / 180;
}

function radiansToDegrees(value: number): number {
  return (value * 180) / Math.PI;
}

function isWebGlAvailable(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
  } catch (error) {
    console.error("[SpherePanorama] WebGL availability check failed.", error);
    return false;
  }
}

function getActiveFilamentPalette(
  filaments: FilamentChannel[],
  customPalette: FilamentChannel[] | null,
): ActiveFilamentPalette {
  if (
    filaments.length >= MIN_CUSTOM_FILAMENT_COUNT &&
    filaments.length <= MAX_CUSTOM_FILAMENT_COUNT &&
    filaments.every((filament) => filament.id.startsWith("custom-"))
  ) {
    return "custom";
  }
  if (customPalette && areFilamentPalettesEqual(filaments, customPalette)) {
    return "custom";
  }

  const hasBlack = filaments.some((filament) => filament.role === "black");
  const hasWhite = filaments.some((filament) => filament.role === "white");
  if (hasBlack && hasWhite) {
    return "blackWhite";
  }
  return hasBlack ? "black" : "white";
}

function getGeneratedColorBounds(filaments: FilamentChannel[]): GeneratedColorBounds {
  const maxPatternCount = estimateFullSpectrumPatternCapacity(filaments);
  const maxTotalByPalette = filaments.length + maxPatternCount;
  const maxTotal = Math.max(filaments.length, Math.min(MAX_TOTAL_COLOR_COUNT, maxTotalByPalette));
  const minTotal = Math.min(MIN_TOTAL_COLOR_COUNT, maxTotal);
  return {
    minTotal,
    maxTotal,
    maxPatternCount,
  };
}

function calculatePaletteCoverageStats(
  canvas: HTMLCanvasElement,
  palette: Rgb[],
  physicalFilamentCount: number,
  patterns: FullSpectrumPattern[],
): PaletteCoverageStats {
  const colorWeights = Array.from({ length: palette.length }, () => 0);
  const physicalWeights = Array.from({ length: physicalFilamentCount }, () => 0);
  const context = canvas.getContext("2d");
  if (!context || palette.length === 0 || canvas.width <= 0 || canvas.height <= 0) {
    return { colorPercents: colorWeights, physicalFilamentPercents: physicalWeights };
  }

  const paletteLookup = new Map<string, number>();
  palette.forEach((rgb, index) => {
    paletteLookup.set(rgbKey(rgb), index);
  });

  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  let totalWeight = 0;

  for (let y = 0; y < canvas.height; y += 1) {
    const rowWeight = Math.sin(((y + 0.5) / canvas.height) * Math.PI);
    for (let x = 0; x < canvas.width; x += 1) {
      const offset = (y * canvas.width + x) * 4;
      const rgb = {
        r: image.data[offset],
        g: image.data[offset + 1],
        b: image.data[offset + 2],
      };
      const colorIndex = paletteLookup.get(rgbKey(rgb)) ?? nearestPaletteIndex(rgb, palette);
      colorWeights[colorIndex] += rowWeight;
      totalWeight += rowWeight;
    }
  }

  colorWeights.forEach((weight, colorIndex) => {
    if (colorIndex < physicalFilamentCount) {
      physicalWeights[colorIndex] += weight;
      return;
    }

    const pattern = patterns[colorIndex - physicalFilamentCount];
    if (!pattern) {
      return;
    }

    const patternWeights = physicalWeightsForPattern(pattern, physicalFilamentCount);
    patternWeights.forEach((patternWeight, filamentIndex) => {
      physicalWeights[filamentIndex] += weight * patternWeight;
    });
  });

  if (totalWeight <= 0) {
    return { colorPercents: colorWeights, physicalFilamentPercents: physicalWeights };
  }

  return {
    colorPercents: colorWeights.map((weight) => (weight / totalWeight) * 100),
    physicalFilamentPercents: physicalWeights.map((weight) => (weight / totalWeight) * 100),
  };
}

function rgbKey(rgb: Rgb): string {
  return `${Math.round(rgb.r)},${Math.round(rgb.g)},${Math.round(rgb.b)}`;
}

function nearestPaletteIndex(rgb: Rgb, palette: Rgb[]): number {
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  palette.forEach((candidate, index) => {
    const distance = colorDistance(rgb, candidate);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });
  return bestIndex;
}

function physicalWeightsForPattern(pattern: FullSpectrumPattern, physicalFilamentCount: number): number[] {
  const weights = Array.from({ length: physicalFilamentCount }, () => 0);
  const steps = pattern.expandedPattern.split("");
  steps.forEach((step) => {
    const index = Number(step) - 1;
    if (index >= 0 && index < physicalFilamentCount) {
      weights[index] += 1 / Math.max(1, steps.length);
    }
  });
  return weights;
}

function formatCoveragePercent(value: number): string {
  if (value > 0 && value < 0.1) {
    return "<0.1%";
  }

  return `${value.toFixed(value >= 10 ? 0 : 1)}%`;
}

function loadFilamentInventoryText(): string {
  try {
    const stored = window.localStorage.getItem(FILAMENT_INVENTORY_STORAGE_KEY);
    if (stored && stored.trim().length > 0) {
      return stored;
    }
  } catch (error) {
    console.warn("[SpherePanorama] Could not load filament inventory.", error);
  }

  return formatFilamentInventory(createDefaultFilaments("blackWhite"));
}

function saveFilamentInventoryText(value: string): void {
  try {
    window.localStorage.setItem(FILAMENT_INVENTORY_STORAGE_KEY, value);
  } catch (error) {
    console.warn("[SpherePanorama] Could not save filament inventory.", error);
  }
}

function formatFilamentInventory(filaments: FilamentChannel[]): string {
  return filaments.map((filament) => `${filament.name}, ${normalizeHex(filament.hex)}, ${filament.role}`).join("\n");
}

function parseFilamentInventory(text: string): FilamentChannel[] {
  const filaments: FilamentChannel[] = [];
  const seen = new Set<string>();

  text.split(/\r?\n/).forEach((line) => {
    const hexMatch = line.match(/#?[0-9a-fA-F]{6}\b|#?[0-9a-fA-F]{3}\b/);
    if (!hexMatch) {
      return;
    }

    const hex = normalizeHex(hexMatch[0]);
    const parts = line.split(",").map((part) => part.trim()).filter(Boolean);
    const role = parts.length >= 3 ? parts
      .map((part) => part.toLowerCase())
      .find((part): part is FilamentRole => isFilamentRole(part)) : undefined;
    const name = (parts.length > 1
      ? parts
          .filter((part) => !(isHexColor(part) && normalizeHex(part) === hex) && part.toLowerCase() !== role)
          .join(", ")
      : line.replace(hexMatch[0], ""))
        .replace(/^[\s,;:-]+|[\s,;:-]+$/g, "")
        .trim();
    const key = `${name.toLowerCase()}:${hex}`;
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    filaments.push(createFilament(`inventory-${filaments.length + 1}`, name || `Filament ${filaments.length + 1}`, hex, role));
  });

  return filaments;
}

function selectBestFilamentsForImage(
  canvas: HTMLCanvasElement,
  settings: ProcessingSettings,
  inventory: FilamentChannel[],
  targetCount: number,
): FilamentChannel[] {
  const target = Math.min(MAX_CUSTOM_FILAMENT_COUNT, Math.max(MIN_CUSTOM_FILAMENT_COUNT, targetCount));
  const candidates = inventory.slice();
  if (candidates.length <= target) {
    return cloneFilaments(candidates);
  }

  const samples = sampleImageColors(canvas, settings);
  const selected: FilamentChannel[] = [];
  while (selected.length < target) {
    let bestCandidate: FilamentChannel | null = null;
    let bestScore = Number.POSITIVE_INFINITY;

    candidates.forEach((candidate) => {
      if (selected.some((filament) => filament.id === candidate.id)) {
        return;
      }

      const score = scoreFilamentPalette(samples, [...selected, candidate]);
      if (score < bestScore) {
        bestScore = score;
        bestCandidate = candidate;
      }
    });

    if (!bestCandidate) {
      break;
    }
    selected.push(bestCandidate);
  }

  improveSelectedFilaments(samples, selected, candidates);
  return cloneFilaments(selected);
}

function sampleImageColors(canvas: HTMLCanvasElement, settings: ProcessingSettings): ImageColorSample[] {
  const context = canvas.getContext("2d");
  if (!context) {
    return [{ rgb: { r: 255, g: 255, b: 255 }, weight: 1 }];
  }

  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  const step = Math.max(1, Math.floor(Math.sqrt((canvas.width * canvas.height) / AUTO_PICK_SAMPLE_TARGET)));
  const buckets = new Map<string, { r: number; g: number; b: number; count: number }>();

  for (let y = 0; y < canvas.height; y += step) {
    for (let x = 0; x < canvas.width; x += step) {
      const offset = (y * canvas.width + x) * 4;
      const adjusted = applyColorAdjustments(
        {
          r: image.data[offset],
          g: image.data[offset + 1],
          b: image.data[offset + 2],
        },
        settings,
      );
      const key = `${Math.round(adjusted.r / 16)},${Math.round(adjusted.g / 16)},${Math.round(adjusted.b / 16)}`;
      const bucket = buckets.get(key) ?? { r: 0, g: 0, b: 0, count: 0 };
      bucket.r += adjusted.r;
      bucket.g += adjusted.g;
      bucket.b += adjusted.b;
      bucket.count += 1;
      buckets.set(key, bucket);
    }
  }

  return [...buckets.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, AUTO_PICK_COLOR_BUCKET_LIMIT)
    .map((bucket) => ({
      rgb: {
        r: bucket.r / bucket.count,
        g: bucket.g / bucket.count,
        b: bucket.b / bucket.count,
      },
      weight: Math.sqrt(bucket.count),
    }));
}

function scoreFilamentPalette(samples: ImageColorSample[], palette: FilamentChannel[]): number {
  return samples.reduce((score, sample) => {
    const nearest = Math.min(...palette.map((filament) => colorDistance(sample.rgb, filament.rgb)));
    return score + nearest * sample.weight;
  }, 0);
}

function improveSelectedFilaments(
  samples: ImageColorSample[],
  selected: FilamentChannel[],
  candidates: FilamentChannel[],
): void {
  let bestScore = scoreFilamentPalette(samples, selected);
  let improved = true;

  while (improved) {
    improved = false;
    for (let selectedIndex = 0; selectedIndex < selected.length; selectedIndex += 1) {
      for (const candidate of candidates) {
        if (selected.some((filament) => filament.id === candidate.id)) {
          continue;
        }

        const next = selected.slice();
        next[selectedIndex] = candidate;
        const score = scoreFilamentPalette(samples, next);
        if (score < bestScore) {
          selected[selectedIndex] = candidate;
          bestScore = score;
          improved = true;
        }
      }
    }
  }
}

function createDefaultCustomPaletteDraft(): EditableFilament[] {
  return createEditableFilaments(createDefaultFilaments("blackWhite")).slice(0, DEFAULT_PHYSICAL_FILAMENT_COUNT);
}

function createDefaultCustomFilament(index: number): EditableFilament {
  const defaults = createEditableFilaments(createDefaultFilaments("blackWhite"));
  return defaults[index] ?? { id: `custom-${index + 1}`, name: `Filament ${index + 1}`, hex: "#FFFFFF", role: "custom" };
}

function createEditableFilaments(filaments: FilamentChannel[]): EditableFilament[] {
  return filaments.slice(0, MAX_CUSTOM_FILAMENT_COUNT).map((filament, index) => ({
    id: `custom-draft-${index + 1}`,
    name: filament.name || `Filament ${index + 1}`,
    hex: normalizeHex(filament.hex),
    role: filament.role,
  }));
}

function normalizeCustomPaletteDraft(draft: EditableFilament[]): FilamentChannel[] {
  return draft.slice(0, MAX_CUSTOM_FILAMENT_COUNT).map((filament, index) =>
    createFilament(
      `custom-${index + 1}`,
      filament.name.trim() || `Filament ${index + 1}`,
      normalizeHex(filament.hex),
      filament.role,
    ),
  );
}

function isValidCustomPaletteDraft(draft: EditableFilament[]): boolean {
  return (
    draft.length >= MIN_CUSTOM_FILAMENT_COUNT &&
    draft.length <= MAX_CUSTOM_FILAMENT_COUNT &&
    draft.every((filament) => filament.name.trim().length > 0 && isHexColor(filament.hex))
  );
}

function isHexColor(value: string): boolean {
  const raw = value.trim().startsWith("#") ? value.trim().slice(1) : value.trim();
  return /^[0-9a-fA-F]{3}$/.test(raw) || /^[0-9a-fA-F]{6}$/.test(raw);
}

function cloneFilaments(filaments: FilamentChannel[]): FilamentChannel[] {
  return filaments.map((filament) => ({
    ...filament,
    rgb: { ...filament.rgb },
  }));
}

function applyPatternCalibrations(
  patterns: FullSpectrumPattern[],
  calibrations: Record<string, string>,
): FullSpectrumPattern[] {
  return patterns.map((pattern) => {
    const calibration = calibrations[pattern.id];
    if (!calibration || !isHexColor(calibration)) {
      return pattern;
    }
    const hex = normalizeHex(calibration);
    return { ...pattern, hex, rgb: hexToRgb(hex) };
  });
}

function updateFilamentHex(filament: FilamentChannel, hex: string | undefined): FilamentChannel {
  if (!hex) {
    return filament;
  }

  const rgb = hexToRgb(hex);
  const normalizedHex = rgbToHex(rgb);
  return normalizedHex === normalizeHex(filament.hex) ? filament : { ...filament, hex: normalizedHex, rgb };
}

function areFilamentPalettesEqual(a: FilamentChannel[], b: FilamentChannel[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (filament, index) =>
        filament.name === b[index]?.name &&
        normalizeHex(filament.hex) === normalizeHex(b[index]?.hex ?? "") &&
        filament.role === b[index]?.role,
    )
  );
}

function NumberField({
  label,
  suffix,
  value,
  min,
  max,
  step,
  disabled,
  onChange,
}: {
  label: string;
  suffix: string;
  value: number;
  min: number;
  max: number;
  step: number;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  const [draftValue, setDraftValue] = useState(() => formatRangeInputValue(value, step));

  useEffect(() => {
    setDraftValue(formatRangeInputValue(value, step));
  }, [step, value]);

  function commitValue(rawValue: string) {
    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed)) {
      setDraftValue(formatRangeInputValue(value, step));
      return;
    }

    const nextValue = clampNumber(parsed, min, max);
    setDraftValue(formatRangeInputValue(nextValue, step));
    if (Math.abs(nextValue - value) > 0.000001) {
      onChange(nextValue);
    }
  }

  return (
    <label className="field">
      <span>{label}</span>
      <div className="numberInput">
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          value={draftValue}
          onChange={(event) => setDraftValue(event.target.value)}
          onBlur={(event) => commitValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              commitValue(event.currentTarget.value);
              event.currentTarget.blur();
            }
            if (event.key === "Escape") {
              setDraftValue(formatRangeInputValue(value, step));
              event.currentTarget.blur();
            }
          }}
        />
        <em>{suffix}</em>
      </div>
    </label>
  );
}

function DiameterField({
  diameterMm,
  unit,
  onUnitChange,
  onChangeMm,
}: {
  diameterMm: number;
  unit: DiameterUnit;
  onUnitChange: (unit: DiameterUnit) => void;
  onChangeMm: (value: number) => void;
}) {
  const value = unit === "in" ? Number((diameterMm / MM_PER_INCH).toFixed(3)) : Number(diameterMm.toFixed(2));
  const step = unit === "in" ? 0.05 : 1;
  const min = unit === "in" ? 0.75 : 20;
  const max = unit === "in" ? 12 : 300;
  const [draftValue, setDraftValue] = useState(() => formatRangeInputValue(value, step));

  useEffect(() => {
    setDraftValue(formatRangeInputValue(value, step));
  }, [step, value]);

  function commitValue(rawValue: string) {
    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed)) {
      setDraftValue(formatRangeInputValue(value, step));
      return;
    }
    const next = clampNumber(parsed, min, max);
    setDraftValue(formatRangeInputValue(next, step));
    onChangeMm(unit === "in" ? next * MM_PER_INCH : next);
  }

  return (
    <label className="field">
      <span>Diameter</span>
      <div className="unitInput">
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          value={draftValue}
          onChange={(event) => setDraftValue(event.target.value)}
          onBlur={(event) => commitValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              commitValue(event.currentTarget.value);
              event.currentTarget.blur();
            }
            if (event.key === "Escape") {
              setDraftValue(formatRangeInputValue(value, step));
              event.currentTarget.blur();
            }
          }}
        />
        <select value={unit} onChange={(event) => onUnitChange(event.target.value as DiameterUnit)}>
          <option value="mm">mm</option>
          <option value="in">in</option>
        </select>
      </div>
      <small>
        Exports remain in millimeters. Current diameter: {diameterMm.toFixed(1)} mm /{" "}
        {(diameterMm / MM_PER_INCH).toFixed(2)} in.
      </small>
    </label>
  );
}

function RangeField({
  label,
  value,
  min,
  max,
  step,
  display,
  inputSuffix,
  allowManualEntry,
  resetValue,
  disabled,
  onChange,
  onReset,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  inputSuffix?: string;
  allowManualEntry?: boolean;
  resetValue?: number;
  disabled?: boolean;
  onChange: (value: number) => void;
  onReset?: () => void;
}) {
  const rangeId = useId();
  const numberId = useId();
  const [manualValue, setManualValue] = useState(() => formatRangeInputValue(value, step));
  const canReset = resetValue !== undefined && Math.abs(value - resetValue) > 0.000001;

  useEffect(() => {
    setManualValue(formatRangeInputValue(value, step));
  }, [step, value]);

  function commitManualValue(rawValue: string) {
    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed)) {
      setManualValue(formatRangeInputValue(value, step));
      return;
    }

    const nextValue = clampNumber(parsed, min, max);
    setManualValue(formatRangeInputValue(nextValue, step));
    if (Math.abs(nextValue - value) > 0.000001) {
      onChange(nextValue);
    }
  }

  return (
    <div className={`rangeField ${disabled ? "disabled" : ""}`}>
      <label className="rangeHeader" htmlFor={rangeId}>
        {label}
        <strong>{display}</strong>
      </label>
      <input
        id={rangeId}
        type="range"
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      {allowManualEntry && (
        <div className="rangeManualControls">
          <label className="rangeNumberControl" htmlFor={numberId}>
            <span>Value</span>
            <div className="rangeNumberInput">
              <input
                id={numberId}
                type="number"
                min={min}
                max={max}
                step={step}
                disabled={disabled}
                value={manualValue}
                aria-label={`${label} value`}
                onChange={(event) => setManualValue(event.target.value)}
                onBlur={(event) => commitManualValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    commitManualValue(event.currentTarget.value);
                    event.currentTarget.blur();
                  }
                  if (event.key === "Escape") {
                    setManualValue(formatRangeInputValue(value, step));
                    event.currentTarget.blur();
                  }
                }}
              />
              {inputSuffix && <em>{inputSuffix}</em>}
            </div>
          </label>
          {onReset && (
            <button
              className="rangeResetButton"
              type="button"
              disabled={disabled || !canReset}
              aria-label={`Reset ${label}`}
              title={`Reset ${label}`}
              onClick={onReset}
            >
              <RotateCcw size={15} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function formatRangeInputValue(value: number, step: number): string {
  const precision = getStepPrecision(step);
  if (precision === 0) {
    return `${Math.round(value)}`;
  }

  return value.toFixed(precision).replace(/\.?0+$/, "");
}

function getStepPrecision(step: number): number {
  const stepText = step.toString();
  if (!stepText.includes(".")) {
    return 0;
  }

  return stepText.split(".")[1]?.length ?? 0;
}

function createMeshEntries(settings: SphereSettings): ThreeMfEntry[] {
  if (settings.splitMode === "hemispheres") {
    const entries: ThreeMfEntry[] = [
      { name: "top_half", mesh: generateSphereMesh(settings, "top") },
      { name: "bottom_half", mesh: generateSphereMesh(settings, "bottom") },
    ];
    if (settings.flatBase === "pedestal") {
      entries.push({ name: "pedestal", mesh: generatePedestalMesh(settings) });
    }
    return entries;
  }

  const entries: ThreeMfEntry[] = [{ name: "full_sphere", mesh: generateSphereMesh(settings, "full") }];
  if (settings.flatBase === "pedestal") {
    entries.push({ name: "pedestal", mesh: generatePedestalMesh(settings) });
  }
  return entries;
}

function exportProfileGuidance(profile: ExportProfile): string {
  if (profile === "snapmakerOrca") {
    return "Recommended for generated FullSpectrum blends. Verify imported virtual filament definitions and tool changes before slicing.";
  }
  if (profile === "bambuOrca") {
    return "Exports slicer paint colors and Orca-style metadata. Stock builds may display generated blends without applying layer alternation.";
  }
  if (profile === "standard3mf") {
    return "Portable 3MF color groups only. Use this for display colors; mixed FullSpectrum layer recipes are not embedded for a slicer.";
  }
  return "Embeds the aligned panorama as an image texture. This is useful for viewing, but most slicers will not turn the texture into multicolor toolpaths.";
}

function parseProjectFile(value: unknown): SphereProjectFile {
  if (!isRecord(value) || value.version !== PROJECT_FILE_VERSION) {
    throw new Error("Project import failed. This is not a supported Sphere Panorama project file.");
  }

  const filaments = parseProjectFilaments(value.filaments);
  if (filaments.length < MIN_CUSTOM_FILAMENT_COUNT || filaments.length > MAX_CUSTOM_FILAMENT_COUNT) {
    throw new Error("Project import failed. A project must contain 2 to 5 physical filament colors.");
  }

  const sphereSettings = normalizeSphereSettings({
    ...defaultSphereSettings,
    ...(isRecord(value.sphereSettings) ? value.sphereSettings : {}),
    rotationDeg: {
      ...defaultSphereSettings.rotationDeg,
      ...(isRecord(value.sphereSettings) && isRecord(value.sphereSettings.rotationDeg) ? value.sphereSettings.rotationDeg : {}),
    },
  } as SphereSettings);
  const processingSettings = normalizeProcessingSettings({
    ...defaultProcessingSettings,
    ...(isRecord(value.processingSettings) ? value.processingSettings : {}),
  } as ProcessingSettings, filaments.length);
  const customPalette = value.customPalette === null || value.customPalette === undefined
    ? null
    : parseProjectFilaments(value.customPalette);
  if (customPalette && customPalette.length < MIN_CUSTOM_FILAMENT_COUNT) {
    throw new Error("Project import failed. A saved custom palette must contain at least two colors.");
  }
  const rawOffset = isRecord(value.panoramaOffset) ? value.panoramaOffset : {};
  const image = parseProjectImage(value.image);

  return {
    version: PROJECT_FILE_VERSION,
    sphereSettings,
    processingSettings,
    filaments,
    customPalette,
    patternCalibrations: parsePatternCalibrations(value.patternCalibrations),
    pedestalFilamentIndex: clampFiniteNumber(readNumber(value.pedestalFilamentIndex), 0, filaments.length - 1, 0),
    showAssembledPedestal: Boolean(value.showAssembledPedestal),
    panoramaOffset: {
      x: normalizeOffset(readNumber(rawOffset.x) ?? 0),
      y: normalizeOffset(readNumber(rawOffset.y) ?? 0),
    },
    panoramaRotationDeg: normalizeRightAngle(readNumber(value.panoramaRotationDeg) ?? 0),
    guideRotationDeg: normalizeRightAngle(readNumber(value.guideRotationDeg) ?? 0),
    exportProfile: isExportProfile(value.exportProfile) ? value.exportProfile : "snapmakerOrca",
    image,
  };
}

function parsePatternCalibrations(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string" && isHexColor(entry[1]))
      .map(([patternId, hex]) => [patternId, normalizeHex(hex)]),
  );
}

function parseProjectFilaments(value: unknown): FilamentChannel[] {
  if (!Array.isArray(value)) {
    throw new Error("Project import failed. Filament settings are missing.");
  }

  return value.slice(0, MAX_CUSTOM_FILAMENT_COUNT).map((entry, index) => {
    if (!isRecord(entry) || typeof entry.hex !== "string" || !isHexColor(entry.hex)) {
      throw new Error(`Project import failed. Filament ${index + 1} does not have a valid hex color.`);
    }
    const name = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : `Filament ${index + 1}`;
    const id = typeof entry.id === "string" && entry.id.trim() ? entry.id.trim() : `project-${index + 1}`;
    return createFilament(id, name, entry.hex, isFilamentRole(entry.role) ? entry.role : undefined);
  });
}

function parseProjectImage(value: unknown): SphereProjectFile["image"] {
  if (value === null || value === undefined) {
    return null;
  }
  if (!isRecord(value) || typeof value.dataUrl !== "string" || !value.dataUrl.startsWith("data:image/")) {
    throw new Error("Project import failed. The saved panorama image is invalid.");
  }
  return {
    fileName: typeof value.fileName === "string" && value.fileName.trim() ? value.fileName.trim() : "project-panorama.png",
    originalWidth: clampFiniteNumber(readNumber(value.originalWidth), 1, 100000, 1),
    originalHeight: clampFiniteNumber(readNumber(value.originalHeight), 1, 100000, 1),
    dataUrl: value.dataUrl,
  };
}

function createLoadedImageInfo(fileName: string, originalWidth: number, originalHeight: number, canvas: HTMLCanvasElement): LoadedImageInfo {
  const aspectRatio = originalWidth / Math.max(1, originalHeight);
  const likelyPanorama = Math.abs(aspectRatio - 2) <= 0.12;
  const warnings = likelyPanorama ? [] : [`Image ratio is ${aspectRatio.toFixed(2)}:1. Equirectangular panoramas are normally 2:1.`];
  if (canvas.width !== originalWidth || canvas.height !== originalHeight) {
    warnings.push(`Project uses a ${canvas.width} x ${canvas.height} browser-safe working texture.`);
  }
  return {
    fileName,
    originalWidth,
    originalHeight,
    canvas,
    aspectRatio,
    likelyPanorama,
    downscaled: canvas.width !== originalWidth || canvas.height !== originalHeight,
    warnings,
  };
}

function dataUrlToCanvas(dataUrl: string): Promise<HTMLCanvasElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      if (image.naturalWidth * image.naturalHeight > MAX_UPLOAD_IMAGE_PIXELS) {
        reject(new Error("Project import failed. The saved panorama is larger than 64 megapixels."));
        return;
      }
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d");
      if (!context) {
        reject(new Error("Project import failed. Browser canvas 2D context is unavailable."));
        return;
      }
      context.drawImage(image, 0, 0);
      resolve(canvas);
    };
    image.onerror = () => reject(new Error("Project import failed. The saved panorama could not be decoded."));
    image.src = dataUrl;
  });
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isFilamentRole(value: unknown): value is FilamentRole {
  return value === "cyan" || value === "magenta" || value === "yellow" || value === "black" || value === "white" || value === "custom";
}

function isExportProfile(value: unknown): value is ExportProfile {
  return value === "snapmakerOrca" || value === "bambuOrca" || value === "standard3mf" || value === "texture3mf";
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default App;
