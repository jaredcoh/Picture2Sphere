# Picture2Sphere

Picture2Sphere is a high-performance, web-based utility for converting panoramic HDR images into multi-material, 3D-printable spheres.

## 🚀 Features

*   **Filament & Layer Control**: 
    *   Adjust filament inventory (2-5 colors).
    *   Fine-tune layer heights (0.04mm to 0.6mm).
    *   Auto-pick colors based on image analysis.
*   **Precision Geometry**:
    *   Configurable sphere diameter.
    *   Hollow shell and integrated pedestal generation.
*   **Advanced Visualization**:
    *   **Slicer Color Map**: View the quantized color output.
    *   **Print Preview**: Simulate the final physical object (Ball or Flat).
    *   **Material Analytics**: View filament usage percentages.
*   **Professional Export**:
    *   Direct-to-Slicer 3MF export with per-triangle color painting.
    *   Auto-orientation logic to reduce filament waste.
    *   Hemisphere splitting for support-free printing.

## 🛠️ Technology Stack

*   **Frontend**: React, TypeScript, Three.js, @react-three/fiber
*   **Processing**: GainMap-JS (HDR support), fflate (compression)
*   **Formats**: 3MF, STL, OBJ

## 📦 Installation

```bash
npm install
npm run dev
```

## 📄 License

MIT