// lib/utils/generate-layers.ts
function generateLayerNames(numLayers) {
  const names = ["F.Cu"];
  for (let i = 1; i < numLayers - 1; i++) {
    names.push(`In${i}.Cu`);
  }
  names.push("B.Cu");
  return names;
}
function getViaPadstackName(numLayers, outerDiameter, holeDiameter) {
  return `Via[0-${numLayers - 1}]_${outerDiameter}:${holeDiameter}_um`;
}
function generateLayers(numLayers) {
  const layers = [];
  layers.push({
    name: "F.Cu",
    type: "signal",
    property: {
      index: 0
    }
  });
  for (let i = 1; i < numLayers - 1; i++) {
    layers.push({
      name: `In${i}.Cu`,
      type: "signal",
      property: {
        index: i
      }
    });
  }
  layers.push({
    name: "B.Cu",
    type: "signal",
    property: {
      index: numLayers - 1
    }
  });
  return layers;
}

// lib/dsn-pcb/circuit-json-to-dsn-json/process-components-and-pads.ts
import { su } from "@tscircuit/soup-util";

// lib/utils/create-padstack.ts
function createCircularPadstack(name, outerDiameter, holeDiameter, numLayers = 2) {
  return {
    name,
    shapes: generateLayerNames(numLayers).map((layer) => ({
      shapeType: "circle",
      layer,
      diameter: outerDiameter
    })),
    hole: {
      shape: "circle",
      diameter: holeDiameter
    },
    attach: "off"
  };
}
function createOvalPadstack(name, outerWidth, outerHeight, holeWidth, holeHeight, numLayers = 2) {
  const pathOffset = Math.abs(outerWidth - outerHeight) / 2;
  const isHorizontal = outerWidth > outerHeight;
  return {
    name,
    shapes: generateLayerNames(numLayers).map((layer) => ({
      shapeType: "path",
      layer,
      width: isHorizontal ? outerHeight : outerWidth,
      coordinates: isHorizontal ? [-pathOffset, 0, pathOffset, 0] : [0, -pathOffset, 0, pathOffset]
      // Vertical oval
    })),
    hole: {
      shape: "oval",
      width: holeWidth,
      height: holeHeight
    },
    attach: "off"
  };
}
function createRectangularPadstack(name, width, height, layer) {
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  return {
    name,
    shapes: [
      {
        shapeType: "polygon",
        layer: layer === "bottom" ? "B.Cu" : "F.Cu",
        width: 0,
        coordinates: [
          -halfWidth,
          halfHeight,
          // Top left
          halfWidth,
          halfHeight,
          // Top right
          halfWidth,
          -halfHeight,
          // Bottom right
          -halfWidth,
          -halfHeight,
          // Bottom left
          -halfWidth,
          halfHeight
          // Back to top left to close the polygon
        ]
      }
    ],
    attach: "off"
  };
}
function createPolygonPadstack({
  name,
  coordinates,
  layer
}) {
  return {
    name,
    shapes: [
      {
        shapeType: "polygon",
        layer: layer === "bottom" ? "B.Cu" : "F.Cu",
        width: 0,
        coordinates
      }
    ],
    attach: "off"
  };
}
function createCircularHoleRectangularPadstack(name, outerWidth, outerHeight, holeDiameter, numLayers = 2) {
  const halfWidth = outerWidth / 2;
  const halfHeight = outerHeight / 2;
  const rectPolygon = [
    -halfWidth,
    halfHeight,
    // Top-left
    halfWidth,
    halfHeight,
    // Top-right
    halfWidth,
    -halfHeight,
    // Bottom-right
    -halfWidth,
    -halfHeight,
    // Bottom-left
    -halfWidth,
    halfHeight
    // Close the polygon
  ];
  return {
    name,
    shapes: generateLayerNames(numLayers).map((layer) => ({
      shapeType: "polygon",
      layer,
      width: 0,
      coordinates: rectPolygon
    })),
    hole: {
      shape: "circle",
      diameter: holeDiameter
    },
    attach: "off"
  };
}

// lib/utils/get-padstack-name.ts
var padstackNamePrefixes = {
  circle: "Round[",
  oval: "Oval[",
  pill: "Oval[",
  rect: "RoundRect[",
  polygon: "Cust["
};
var padstackLayerByCode = {
  T: "top",
  B: "bottom",
  A: "all"
};
var padstackLayerCodeByLayer = {
  top: "T",
  bottom: "B",
  all: "A"
};
function isPadstackLayerCode(layerCode) {
  return layerCode === "T" || layerCode === "B" || layerCode === "A";
}
function parsePadstackLayer(layerCode) {
  if (!isPadstackLayerCode(layerCode)) return null;
  return padstackLayerByCode[layerCode];
}
function parseMicrometers(micrometersText) {
  return Number(micrometersText) / 1e3;
}
function getPadstackLayerCode(layer) {
  if (layer === "bottom" || layer === "all") {
    return padstackLayerCodeByLayer[layer];
  }
  return padstackLayerCodeByLayer.top;
}
function getPadstackName({
  shape,
  width,
  height,
  holeDiameter,
  outerDiameter,
  layer = "top",
  customDescriptor
}) {
  const layerCode = getPadstackLayerCode(layer);
  switch (shape) {
    case "circle":
      return `${padstackNamePrefixes.circle}${layerCode}]Pad_${holeDiameter}_${outerDiameter}_um`;
    case "oval":
      return `${padstackNamePrefixes.oval}${layerCode}]Pad_${width}x${height}_um`;
    case "pill":
      return `${padstackNamePrefixes.pill}${layerCode}]Pad_${width}x${height}_um`;
    case "rect":
      return `${padstackNamePrefixes.rect}${layerCode}]Pad_${width}x${height}_um`;
    case "polygon":
      return `${padstackNamePrefixes.polygon}${layerCode}]Pad_${customDescriptor ?? `${width}x${height}`}_um`;
    default:
      return "default_pad";
  }
}
function parsePadstackName(padstackName) {
  const circleMatch = padstackName.match(
    /^Round\[([TBA])\]Pad_([0-9]+(?:\.[0-9]+)?)_([0-9]+(?:\.[0-9]+)?)_um$/
  );
  if (circleMatch) {
    const layer = parsePadstackLayer(circleMatch[1]);
    if (!layer) return null;
    return {
      shape: "circle",
      layer,
      holeDiameter: parseMicrometers(circleMatch[2]),
      outerDiameter: parseMicrometers(circleMatch[3])
    };
  }
  const ovalMatch = padstackName.match(
    /^Oval\[([TBA])\]Pad_([0-9]+(?:\.[0-9]+)?)x([0-9]+(?:\.[0-9]+)?)_um$/
  );
  if (ovalMatch) {
    const layer = parsePadstackLayer(ovalMatch[1]);
    if (!layer) return null;
    return {
      shape: "oval",
      layer,
      width: parseMicrometers(ovalMatch[2]),
      height: parseMicrometers(ovalMatch[3])
    };
  }
  const rectMatch = padstackName.match(
    /^RoundRect\[([TBA])\]Pad_([0-9]+(?:\.[0-9]+)?)x([0-9]+(?:\.[0-9]+)?)_um$/
  );
  if (rectMatch) {
    const layer = parsePadstackLayer(rectMatch[1]);
    if (!layer) return null;
    return {
      shape: "rect",
      layer,
      width: parseMicrometers(rectMatch[2]),
      height: parseMicrometers(rectMatch[3])
    };
  }
  const polygonMatch = padstackName.match(/^Cust\[([TBA])\]Pad_(.+)_um$/);
  if (polygonMatch) {
    const layer = parsePadstackLayer(polygonMatch[1]);
    if (!layer) return null;
    return {
      shape: "polygon",
      layer,
      descriptor: polygonMatch[2]
    };
  }
  return null;
}

// lib/utils/get-polygon-smt-pad-geometry.ts
import { getBoundsFromPoints } from "@tscircuit/math-utils";
function roundMicrons(microns) {
  return Number(microns.toFixed(3));
}
function getNormalizedPoints(points) {
  if (points.length < 2) return points;
  const firstPoint = points[0];
  const lastPoint = points[points.length - 1];
  if (firstPoint.x === lastPoint.x && firstPoint.y === lastPoint.y) {
    return points.slice(0, -1);
  }
  return points;
}
function getPolygonCentroid(points) {
  let signedArea = 0;
  let centroidX = 0;
  let centroidY = 0;
  for (let index = 0; index < points.length; index++) {
    const currentPoint = points[index];
    const nextPoint = points[(index + 1) % points.length];
    const crossProduct = currentPoint.x * nextPoint.y - nextPoint.x * currentPoint.y;
    signedArea += crossProduct;
    centroidX += (currentPoint.x + nextPoint.x) * crossProduct;
    centroidY += (currentPoint.y + nextPoint.y) * crossProduct;
  }
  if (signedArea === 0) return null;
  const areaFactor = signedArea * 3;
  return {
    x: centroidX / areaFactor,
    y: centroidY / areaFactor
  };
}
function getPolygonSmtPadGeometry(pad) {
  const points = getNormalizedPoints(pad.points);
  const bounds = getBoundsFromPoints(points);
  if (!bounds) {
    return {
      center: { x: 0, y: 0 },
      widthUm: 0,
      heightUm: 0,
      relativePointsUm: []
    };
  }
  const { minX, maxX, minY, maxY } = bounds;
  const polygonCentroid = getPolygonCentroid(points);
  const center = polygonCentroid ?? {
    x: (minX + maxX) / 2,
    y: (minY + maxY) / 2
  };
  const relativePointsUm = points.flatMap((point) => [
    roundMicrons((point.x - center.x) * 1e3),
    roundMicrons((point.y - center.y) * 1e3)
  ]);
  if (points.length > 0) {
    relativePointsUm.push(relativePointsUm[0], relativePointsUm[1]);
  }
  return {
    center,
    widthUm: roundMicrons((maxX - minX) * 1e3),
    heightUm: roundMicrons((maxY - minY) * 1e3),
    relativePointsUm
  };
}

// lib/utils/create-and-add-padstack-for-pcb-smtpad.ts
function createAndAddPadstackFromPcbSmtPad({
  pcb,
  pad,
  processedPadstacks
}) {
  const isCircle = pad.shape === "circle";
  const isPolygon = pad.shape === "polygon";
  const polygonPadGeometry = isPolygon ? getPolygonSmtPadGeometry(pad) : void 0;
  let shape = "rect";
  let outerDiameter;
  let holeDiameter;
  let width;
  let height;
  let customDescriptor;
  if (isCircle) {
    shape = "circle";
    outerDiameter = pad.radius * 1e3 * 2;
    holeDiameter = pad.radius * 1e3 * 2;
  } else if (isPolygon) {
    shape = "polygon";
    width = polygonPadGeometry?.widthUm;
    height = polygonPadGeometry?.heightUm;
    customDescriptor = `${polygonPadGeometry?.widthUm}x${polygonPadGeometry?.heightUm}_${polygonPadGeometry?.relativePointsUm.join("_")}`;
  } else {
    width = pad.width * 1e3;
    height = pad.height * 1e3;
  }
  const padstackParams = {
    shape,
    outerDiameter,
    holeDiameter,
    width,
    height,
    layer: pad.layer,
    customDescriptor
  };
  const padstackName = getPadstackName(padstackParams);
  if (!processedPadstacks.has(padstackName)) {
    let padstack;
    if (isCircle) {
      padstack = createCircularPadstack(
        padstackName,
        padstackParams.outerDiameter,
        padstackParams.holeDiameter
      );
    } else if (isPolygon) {
      padstack = createPolygonPadstack({
        name: padstackName,
        coordinates: polygonPadGeometry.relativePointsUm,
        layer: pad.layer
      });
    } else {
      padstack = createRectangularPadstack(
        padstackName,
        padstackParams.width,
        padstackParams.height,
        pad.layer
      );
    }
    pcb.library.padstacks.push(padstack);
    processedPadstacks.add(padstackName);
  }
  return padstackName;
}

// lib/utils/create-pin-for-image.ts
function createPinForImage({
  pad,
  pcbComponent,
  sourcePort
}) {
  if (!sourcePort) return void 0;
  const isCircle = pad.shape === "circle";
  const isPolygon = pad.shape === "polygon";
  const polygonPadGeometry = isPolygon ? getPolygonSmtPadGeometry(pad) : void 0;
  let shape = "rect";
  let outerDiameter;
  let holeDiameter;
  let width;
  let height;
  let customDescriptor;
  if (isCircle) {
    shape = "circle";
    outerDiameter = pad.radius * 1e3 * 2;
    holeDiameter = pad.radius * 1e3 * 2;
  } else if (isPolygon) {
    shape = "polygon";
    width = polygonPadGeometry?.widthUm;
    height = polygonPadGeometry?.heightUm;
    customDescriptor = `${polygonPadGeometry?.widthUm}x${polygonPadGeometry?.heightUm}_${polygonPadGeometry?.relativePointsUm.join("_")}`;
  } else {
    width = pad.width * 1e3;
    height = pad.height * 1e3;
  }
  const padstackParams = {
    shape,
    outerDiameter,
    holeDiameter,
    width,
    height,
    layer: pad.layer,
    customDescriptor
  };
  const padCenter = isPolygon ? polygonPadGeometry.center : { x: pad.x, y: pad.y };
  return {
    padstack_name: getPadstackName(padstackParams),
    pin_number: sourcePort.port_hints?.find((hint) => !Number.isNaN(Number(hint))) || 1,
    x: (padCenter.x - pcbComponent.center.x) * 1e3,
    y: (padCenter.y - pcbComponent.center.y) * 1e3
  };
}

// lib/utils/get-component-value.ts
function getComponentValue(sourceComponent) {
  if (!sourceComponent) return "";
  if ("resistance" in sourceComponent) {
    return sourceComponent.resistance >= 1e3 ? `${sourceComponent.resistance / 1e3}k` : `${sourceComponent.resistance}`;
  }
  if ("capacitance" in sourceComponent) {
    const capacitanceUF = sourceComponent.capacitance * 1e6;
    if (capacitanceUF >= 1) {
      return `${capacitanceUF}uF`;
    } else {
      return `${capacitanceUF.toFixed(3)}uF`;
    }
  }
  return "";
}

// lib/utils/get-footprint-name.ts
function getFootprintName(sourceComponent, pcbComponent) {
  if (!sourceComponent || !pcbComponent) {
    return "";
  }
  const width = pcbComponent.width == null ? 0 : pcbComponent.width.toFixed(4);
  const height = pcbComponent.height == null ? 0 : pcbComponent.height.toFixed(4);
  return `${sourceComponent.ftype}:${width}x${height}_mm`;
}
// FL PATCH: image names must be unique per PAD GEOMETRY, not just per bounding
// box. Components carry world-space pads (rotation baked in) while every DSN
// place record is emitted at rotation 0 with a SHARED image built from the
// FIRST component of the name group — so a same-size sibling with a different
// pad orientation gets phantom pad positions in the DSN. freerouting then routes
// through the real pads it can't see (shorting_items/mask bridges on export) and
// strands the nets whose pins sit at the phantom spots. Appending a geometry
// signature splits each orientation into its own image.
function flGeomSig(pads, cx, cy) {
  // FL PATCH v2: the signature carries the PIN NUMBER with each position. Two
  // 0402s rotated 180 apart have identical pad positions and swapped pins; they
  // shared an image built from whichever came first, so freerouting put pin 1
  // where the sibling's pad 2 is (measured: a VDD track landing on a decoupling
  // cap's GND pad and on a pull-up's wrong end — shorts + opens on every board
  // with rotated passives). Pin identity follows createPinForImage's rule.
  const pinOf = (p) => (p.port_hints || []).find((h) => !Number.isNaN(Number(h))) || 1;
  const sig = (pads || []).map((p) => `${pinOf(p)}:${Math.round(((p.x ?? 0) - cx) * 1e3)},${Math.round(((p.y ?? 0) - cy) * 1e3)}`).sort().join(";");
  let h = 0;
  for (let i = 0; i < sig.length; i++) h = (h * 31 + sig.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

// lib/dsn-pcb/circuit-json-to-dsn-json/process-components-and-pads.ts
import { applyToPoint, scale } from "transformation-matrix";
var transformMmToUm = scale(1e3);
function processComponentsAndPads(componentGroups, circuitElements, pcb) {
  const processedPadstacks = /* @__PURE__ */ new Set();
  const componentsByFootprint = /* @__PURE__ */ new Map();
  for (const group of componentGroups) {
    const { pcb_component_id, pcb_smtpads } = group;
    if (pcb_smtpads.length === 0) continue;
    const pcbComponent = su(circuitElements).pcb_component.list().find((e) => e.pcb_component_id === pcb_component_id);
    const sourceComponent = su(circuitElements).source_component.list().find((e) => e.source_component_id === pcbComponent?.source_component_id);
    const footprintName = getFootprintName(sourceComponent, pcbComponent) + "_g" + flGeomSig(pcb_smtpads, pcbComponent?.center?.x ?? 0, pcbComponent?.center?.y ?? 0);
    const componentName = sourceComponent?.name || "Unknown";
    const circuitSpaceCoordinates = applyToPoint(
      transformMmToUm,
      pcbComponent.center
    );
    if (!componentsByFootprint.has(footprintName)) {
      componentsByFootprint.set(footprintName, []);
    }
    componentsByFootprint.get(footprintName)?.push({
      componentName,
      coordinates: circuitSpaceCoordinates,
      rotation: pcbComponent?.rotation || 0,
      value: getComponentValue(sourceComponent),
      sourceComponent
    });
  }
  for (const [footprintName, components] of componentsByFootprint) {
    const firstComponent = components[0];
    const componentGroup = componentGroups.find((group) => {
      const pcbComponent = circuitElements.find(
        (e) => e.type === "pcb_component" && e.source_component_id === firstComponent.sourceComponent?.source_component_id
      );
      return pcbComponent && group.pcb_component_id === pcbComponent.pcb_component_id;
    });
    if (!componentGroup) continue;
    for (const pad of componentGroup.pcb_smtpads) {
      createAndAddPadstackFromPcbSmtPad({
        pcb,
        pad,
        processedPadstacks
      });
    }
    const image = {
      name: footprintName,
      outlines: [],
      pins: componentGroup.pcb_smtpads.map((pad) => {
        const pcbComponent = circuitElements.find(
          (e) => e.type === "pcb_component" && e.source_component_id === firstComponent.sourceComponent?.source_component_id
        );
        const pcbPort = su(circuitElements).pcb_port.list().find((e) => e.pcb_port_id === pad.pcb_port_id);
        const sourcePort = su(circuitElements).source_port.list().find((e) => e.source_port_id === pcbPort?.source_port_id);
        return createPinForImage({
          pad,
          pcbComponent,
          sourcePort
        });
      }).filter((pin) => pin !== void 0)
    };
    pcb.library.images.push(image);
    const componentEntry = {
      name: footprintName,
      places: components.map((component) => ({
        refdes: `${component.componentName}_${component.sourceComponent?.source_component_id}`,
        x: component.coordinates.x,
        y: component.coordinates.y,
        side: "front",
        rotation: component.rotation % 90,
        PN: component.value
      }))
    };
    pcb.placement.components.push(componentEntry);
  }
}

// lib/dsn-pcb/circuit-json-to-dsn-json/process-nets.ts
import { su as su2 } from "@tscircuit/soup-util";
function processNets(circuitElements, pcb) {
  const componentNameMap = /* @__PURE__ */ new Map();
  for (const element of circuitElements) {
    if (element.type === "source_component") {
      componentNameMap.set(element.source_component_id, element.name);
    }
  }
  const padsBySourcePortId = /* @__PURE__ */ new Map();
  for (const element of circuitElements) {
    if ((element.type === "pcb_smtpad" || element.type === "pcb_plated_hole") && element.pcb_port_id) {
      const pcbPort = su2(circuitElements).pcb_port.list().find((e) => e.pcb_port_id === element.pcb_port_id);
      if (pcbPort && "source_port_id" in pcbPort) {
        const sourcePort = su2(circuitElements).source_port.list().find((e) => e.source_port_id === pcbPort.source_port_id);
        if (sourcePort && "source_component_id" in sourcePort) {
          const componentName = componentNameMap.get(sourcePort.source_component_id ?? "") || "";
          const pinNumber = sourcePort.port_hints?.find(
            (hint) => !Number.isNaN(Number(hint))
          );
          padsBySourcePortId.set(sourcePort.source_port_id, {
            componentName: `${componentName}_${sourcePort.source_component_id}`,
            pinNumber,
            sourcePortId: sourcePort.source_port_id
          });
        }
      }
    }
  }
  const netMap = /* @__PURE__ */ new Map();
  const netTraceWidthMap = /* @__PURE__ */ new Map();
  for (const element of circuitElements) {
    if (element.type === "source_trace" && element.connected_source_port_ids) {
      const connectedPorts = element.connected_source_port_ids;
      if (connectedPorts.length >= 2) {
        const firstPad = padsBySourcePortId.get(connectedPorts[0]);
        if (firstPad) {
          const netName = `Net-(${firstPad.componentName}-Pad${firstPad.pinNumber})`;
          if (!netMap.has(netName)) {
            netMap.set(netName, /* @__PURE__ */ new Set());
          }
          for (const portId of connectedPorts) {
            const padInfo = padsBySourcePortId.get(portId);
            if (padInfo) {
              netMap.get(netName)?.add(`${padInfo.componentName}-${padInfo.pinNumber}`);
            }
          }
          if ("min_trace_thickness" in element && element.min_trace_thickness) {
            const traceWidthMicrons = element.min_trace_thickness * 1e3;
            netTraceWidthMap.set(netName, traceWidthMicrons);
          }
        }
      }
    }
  }
  for (const [sourcePortId, padInfo] of padsBySourcePortId) {
    let isConnected = false;
    const padIdentifier = `${padInfo.componentName}-${padInfo.pinNumber.replace("pin", "")}`;
    for (const [_, connectedPads] of netMap.entries()) {
      if (Array.from(connectedPads).some(
        (pad) => pad?.toString() === padIdentifier || pad?.toString() === `${padInfo.componentName}-${padInfo.pinNumber}`
      )) {
        isConnected = true;
        break;
      }
    }
    let isInSourceNet = false;
    for (const element of circuitElements) {
      if (element.type === "source_net") {
        const connectedTraces = circuitElements.filter(
          (e) => e.type === "source_trace" && e.connected_source_net_ids?.includes(element.source_net_id) && e.connected_source_port_ids?.includes(sourcePortId)
        );
        if (connectedTraces.length > 0) {
          isInSourceNet = true;
          for (const trace of connectedTraces) {
            if ("min_trace_thickness" in trace && trace.min_trace_thickness) {
              const traceWidthMicrons = trace.min_trace_thickness * 1e3;
              netTraceWidthMap.set(
                `${element.name}_${element.source_net_id}`,
                traceWidthMicrons
              );
              break;
            }
          }
          break;
        }
      }
    }
    if (!isConnected && !isInSourceNet) {
      const unconnectedNetName = `unconnected-(${padInfo.componentName}-Pad${padInfo.pinNumber.replace("pin", "")})`;
      netMap.set(
        unconnectedNetName,
        /* @__PURE__ */ new Set([`${padInfo.componentName}-${padInfo.pinNumber}`])
      );
    }
  }
  for (const element of circuitElements) {
    if (element.type === "source_net") {
      const netName = `${element.name}_${element.source_net_id}`;
      if (!netMap.has(netName)) {
        netMap.set(netName, /* @__PURE__ */ new Set());
      }
      const connectedTraces = circuitElements.filter(
        (e) => e.type === "source_trace" && e.connected_source_net_ids?.includes(element.source_net_id)
      );
      for (const trace of connectedTraces) {
        for (const portId of trace.connected_source_port_ids || []) {
          const padInfo = padsBySourcePortId.get(portId);
          if (padInfo) {
            netMap.get(netName)?.add(`${padInfo.componentName}-${padInfo.pinNumber}`);
          }
        }
        if ("min_trace_thickness" in trace && trace.min_trace_thickness && !netTraceWidthMap.has(netName)) {
          const traceWidthMicrons = trace.min_trace_thickness * 1e3;
          netTraceWidthMap.set(netName, traceWidthMicrons);
        }
      }
    }
  }
  const allNets = Array.from(netMap.keys()).sort((a, b) => {
    if (a === "GND") return -1;
    if (b === "GND") return 1;
    if (a === "VCC") return -1;
    if (b === "VCC") return 1;
    if (a.startsWith("Net-") && !b.startsWith("Net-")) return -1;
    if (!a.startsWith("Net-") && b.startsWith("Net-")) return 1;
    return a.localeCompare(b);
  });
  const traceWidthClassMap = /* @__PURE__ */ new Map();
  const defaultTraceWidth = 200;
  traceWidthClassMap.set(defaultTraceWidth, "kicad_default");
  for (const [netName, traceWidth] of netTraceWidthMap.entries()) {
    if (traceWidth !== defaultTraceWidth && !traceWidthClassMap.has(traceWidth)) {
      const className = `trace_width_${traceWidth}um`;
      traceWidthClassMap.set(traceWidth, className);
      pcb.network.classes.push({
        name: className,
        description: `Trace width ${traceWidth}\u03BCm`,
        net_names: [],
        circuit: {
          use_via: "Via[0-1]_600:300_um"
        },
        rule: {
          clearances: [
            {
              value: 200,
              type: ""
            }
          ],
          width: traceWidth
        }
      });
    }
  }
  const netsByClass = /* @__PURE__ */ new Map();
  for (const netName of allNets) {
    const traceWidth = netTraceWidthMap.get(netName) || defaultTraceWidth;
    const className = traceWidthClassMap.get(traceWidth) || "kicad_default";
    if (!netsByClass.has(className)) {
      netsByClass.set(className, []);
    }
    netsByClass.get(className)?.push(netName);
    pcb.network.nets.push({
      name: netName,
      pins: Array.from(netMap.get(netName) || []).map(
        (pin) => pin.replace("pin", "")
      )
    });
  }
  for (const [className, nets] of netsByClass.entries()) {
    const classIndex = pcb.network.classes.findIndex(
      (c) => c.name === className
    );
    if (classIndex !== -1) {
      pcb.network.classes[classIndex].net_names = nets;
    }
  }
  for (const classObj of pcb.network.classes) {
    if (classObj.net_names.length === 0) {
      classObj.net_names = allNets;
    }
  }
}

// lib/dsn-pcb/circuit-json-to-dsn-json/process-pcb-traces/index.ts
import { su as su3 } from "@tscircuit/soup-util";
import Debug from "debug";

// lib/utils/get-combined-source-port-name.ts
function getCombinedSourcePortName(circuitElements, connectedSourcePortIds) {
  const portInfos = [];
  for (const portId of connectedSourcePortIds) {
    const sourcePort = circuitElements.find(
      (el) => el.type === "source_port" && el.source_port_id === portId
    );
    if (!sourcePort) continue;
    const sourceComponent = circuitElements.find(
      (el) => el.type === "source_component" && el.source_component_id === sourcePort.source_component_id
    );
    if (!sourceComponent) continue;
    const componentName = sourceComponent.name || sourceComponent.source_component_id;
    const portName = sourcePort.name || sourcePort.pin_number?.toString() || portId;
    portInfos.push({
      displayName: `Pad${portName.replace("pin", "")}_${componentName}_${sourcePort.source_component_id}`
    });
  }
  return portInfos.map((p) => p.displayName).join("--");
}

// lib/dsn-pcb/circuit-json-to-dsn-json/process-pcb-traces/DsnTraceOperationsWrapper.ts
var getDsnTraceOperationsWrapper = (dsnObj) => {
  if (dsnObj.is_dsn_pcb) {
    return {
      getNextNetId: () => `Net-${dsnObj.network.nets.length + 1}`,
      addWire: (wire) => {
        dsnObj.wiring.wires.push(wire);
      },
      getStructure: () => dsnObj.structure,
      getLibrary: () => dsnObj.library
    };
  }
  if (dsnObj.is_dsn_session) {
    return {
      getNextNetId: () => `Net-${dsnObj.routes.network_out.nets.length + 1}`,
      getLibrary: () => dsnObj.routes.library_out,
      getStructure: () => null,
      addWire: (wire) => {
        let net = dsnObj.routes.network_out.nets.find(
          (net2) => net2.name === wire.net
        );
        if (!net) {
          net = {
            name: wire.net,
            wires: []
          };
          dsnObj.routes.network_out.nets.push(net);
        }
        net.wires.push(wire);
      }
    };
  }
  throw new Error("Invalid DSN object");
};

// lib/dsn-pcb/circuit-json-to-dsn-json/process-pcb-traces/findOrCreateViaPadstack.ts
function findOrCreateViaPadstack(pcb, outerDiameter, holeDiameter, numLayers = 2) {
  const viaName = getViaPadstackName(numLayers, outerDiameter, holeDiameter);
  const library = pcb.getLibrary();
  const existingPadstack = library.padstacks.find((p) => p.name === viaName);
  if (existingPadstack) {
    return viaName;
  }
  const viaPadstack = {
    name: viaName,
    attach: "off",
    shapes: generateLayerNames(numLayers).map((layer) => ({
      shapeType: "circle",
      layer,
      diameter: outerDiameter
    })),
    hole: {
      shape: "circle",
      diameter: holeDiameter
    }
  };
  library.padstacks.push(viaPadstack);
  return viaName;
}

// lib/dsn-pcb/circuit-json-to-dsn-json/process-pcb-traces/index.ts
var debug = Debug("dsn-converter:processPcbTraces");
var DEFAULT_VIA_DIAMETER = 600;
var DEFAULT_VIA_HOLE = 300;
function layerRefToDsnLayer(layer) {
  if (layer === "top") return "F.Cu";
  if (layer === "bottom") return "B.Cu";
  const innerMatch = String(layer).match(/^inner(\d+)$/);
  if (innerMatch) return `In${innerMatch[1]}.Cu`;
  return String(layer);
}
function createWire(opts) {
  return {
    path: {
      layer: layerRefToDsnLayer(opts.layer),
      width: opts.widthMm,
      coordinates: []
    },
    net: opts.netName,
    type: "route"
  };
}
function hasCoordinatePosition(point) {
  return point.route_type === "wire" || point.route_type === "via";
}
function processPcbTraces(circuitElements, pcb, numLayers = 2) {
  const dsnWrapper = getDsnTraceOperationsWrapper(pcb);
  const CJ_TO_DSN_SCALE = pcb.is_dsn_pcb ? 1e3 : 1e4;
  for (const element of circuitElements) {
    if (element.type === "pcb_trace") {
      const pcbTrace = element;
      const source_trace = su3(circuitElements).source_trace.getWhere({
        source_trace_id: pcbTrace.source_trace_id
      });
      const source_net = source_trace && su3(circuitElements).source_net.list().find(
        (n) => source_trace.connected_source_net_ids.includes(n.source_net_id)
      );
      debug("PCB TRACE\n----------\n", pcbTrace);
      const sourceTraceConnectedPortIds = getCombinedSourcePortName(
        circuitElements,
        source_trace?.connected_source_port_ids || []
      );
      const netName = source_net?.name || `${pcbTrace.source_trace_id}--${sourceTraceConnectedPortIds}` || dsnWrapper.getNextNetId();
      let currentLayer = "";
      let currentWire = null;
      for (let i = 0; i < pcbTrace.route.length; i++) {
        const point = pcbTrace.route[i];
        debug("POINT\n------\n", point);
        if (point.route_type === "wire") {
          const hasLayerChanged = currentLayer && point.layer !== currentLayer;
          const isFirstPoint = !currentWire;
          if (isFirstPoint) {
            currentWire = createWire({
              layer: point.layer,
              widthMm: point.width * CJ_TO_DSN_SCALE,
              netName
            });
            dsnWrapper.addWire(currentWire);
            currentLayer = point.layer;
          }
          if (currentWire && !hasLayerChanged) {
            currentWire.path.coordinates.push(point.x * CJ_TO_DSN_SCALE);
            currentWire.path.coordinates.push(point.y * CJ_TO_DSN_SCALE);
            continue;
          }
          if (hasLayerChanged) {
            const prevPoint = pcbTrace.route[i - 1];
            if (!prevPoint || !hasCoordinatePosition(prevPoint)) {
              currentLayer = point.layer;
              currentWire = createWire({
                layer: point.layer,
                widthMm: point.width * CJ_TO_DSN_SCALE,
                netName
              });
              dsnWrapper.addWire(currentWire);
              currentWire.path.coordinates.push(point.x * CJ_TO_DSN_SCALE);
              currentWire.path.coordinates.push(point.y * CJ_TO_DSN_SCALE);
              continue;
            }
            const viaPadstackName = findOrCreateViaPadstack(
              dsnWrapper,
              DEFAULT_VIA_DIAMETER,
              DEFAULT_VIA_HOLE,
              numLayers
            );
            if (dsnWrapper.getStructure() && !dsnWrapper.getStructure()?.via) {
              dsnWrapper.getStructure().via = viaPadstackName;
            }
            dsnWrapper.addWire({
              path: {
                layer: layerRefToDsnLayer(currentLayer),
                width: DEFAULT_VIA_DIAMETER,
                coordinates: [
                  prevPoint.x * CJ_TO_DSN_SCALE,
                  prevPoint.y * CJ_TO_DSN_SCALE
                ]
              },
              net: netName,
              type: "via"
            });
          }
          continue;
        }
        if (point.route_type === "via") {
          debug("VIA\n----\n", point);
          if (currentWire) {
            currentWire.path.coordinates.push(point.x * CJ_TO_DSN_SCALE);
            currentWire.path.coordinates.push(point.y * CJ_TO_DSN_SCALE);
            currentWire = null;
          }
          const viaPadstackName = findOrCreateViaPadstack(
            dsnWrapper,
            DEFAULT_VIA_DIAMETER,
            DEFAULT_VIA_HOLE,
            numLayers
          );
          debug("VIA PADSTACK NAME:", viaPadstackName);
          if (dsnWrapper.getStructure() && !dsnWrapper.getStructure()?.via) {
            dsnWrapper.getStructure().via = viaPadstackName;
          }
          dsnWrapper.addWire({
            path: {
              layer: layerRefToDsnLayer(point.from_layer),
              width: DEFAULT_VIA_DIAMETER,
              coordinates: [
                point.x * CJ_TO_DSN_SCALE,
                point.y * CJ_TO_DSN_SCALE
              ]
            },
            net: netName,
            type: "via"
          });
          currentLayer = point.to_layer;
          currentWire = null;
        }
      }
    }
  }
  debug(
    "PCB WIRING/NETWORK_OUT AT END",
    JSON.stringify(
      pcb.is_dsn_pcb ? pcb.wiring : pcb.routes.network_out.nets,
      null,
      2
    )
  );
}

// lib/dsn-pcb/circuit-json-to-dsn-json/process-plated-holes.ts
import { su as su4 } from "@tscircuit/soup-util";
import { applyToPoint as applyToPoint2, scale as scale2 } from "transformation-matrix";
var transformMmToUm2 = scale2(1e3);
function processPlatedHoles(componentGroups, circuitElements, pcb, numLayers = 2) {
  const processedPadstacks = /* @__PURE__ */ new Set();
  function ensurePadstack(hole) {
    switch (hole.shape) {
      case "circle": {
        const name = getPadstackName({
          shape: "circle",
          holeDiameter: hole.hole_diameter * 1e3,
          outerDiameter: hole.outer_diameter * 1e3,
          layer: "all"
        });
        if (!processedPadstacks.has(name)) {
          const d = Math.round(hole.outer_diameter * 1e3);
          pcb.library.padstacks.push(
            createCircularPadstack(name, d, d, numLayers)
          );
          processedPadstacks.add(name);
        }
        return name;
      }
      case "oval":
      case "pill": {
        const name = getPadstackName({
          shape: hole.shape,
          width: hole.hole_width * 1e3,
          height: hole.hole_height * 1e3,
          layer: "all"
        });
        if (!processedPadstacks.has(name)) {
          const iW = Math.round(hole.hole_width * 1e3);
          const iH = Math.round(hole.hole_height * 1e3);
          const oW = Math.round(hole.outer_width * 1e3);
          const oH = Math.round(hole.outer_height * 1e3);
          pcb.library.padstacks.push(
            createOvalPadstack(name, oW, oH, iW, iH, numLayers)
          );
          processedPadstacks.add(name);
        }
        return name;
      }
      case "circular_hole_with_rect_pad": {
        const name = getPadstackName({
          shape: "rect",
          width: hole.rect_pad_width * 1e3,
          height: hole.rect_pad_height * 1e3,
          layer: "all"
        });
        if (!processedPadstacks.has(name)) {
          const oW = Math.round(hole.rect_pad_width * 1e3);
          const oH = Math.round(hole.rect_pad_height * 1e3);
          const hD = Math.round(hole.hole_diameter * 1e3);
          pcb.library.padstacks.push(
            createCircularHoleRectangularPadstack(name, oW, oH, hD, numLayers)
          );
          processedPadstacks.add(name);
        }
        return name;
      }
      default:
        throw new Error(`Unsupported plated-hole shape: ${hole.shape}`);
    }
  }
  function ensureImage(name) {
    let image = pcb.library.images.find((img) => img.name === name);
    if (!image) {
      image = { name, outlines: [], pins: [] };
      pcb.library.images.push(image);
    }
    return image;
  }
  function createNextPinNumberGenerator(image) {
    let current = image.pins.reduce((max, p) => {
      const n = Number(
        typeof p.pin_number === "string" ? p.pin_number.replace(/pin/i, "") : p.pin_number
      );
      return Number.isNaN(n) ? max : Math.max(max, n);
    }, 0) + 1;
    return () => current++;
  }
  function findNumericHint(port) {
    const hint = port?.port_hints?.find((h) => !Number.isNaN(Number(h)));
    return hint !== void 0 ? Number(hint) : void 0;
  }
  const componentsByFootprint = /* @__PURE__ */ new Map();
  for (const group of componentGroups) {
    const { pcb_component_id, pcb_plated_holes, pcb_smtpads } = group;
    if (pcb_plated_holes.length === 0) continue;
    const pcbComponent = su4(circuitElements).pcb_component.list().find((e) => e.pcb_component_id === pcb_component_id);
    if (!pcbComponent) continue;
    const sourceComponent = su4(circuitElements).source_component.list().find((e) => e.source_component_id === pcbComponent.source_component_id);
    const footprintName = getFootprintName(sourceComponent, pcbComponent) + "_g" + flGeomSig([...pcb_plated_holes, ...pcb_smtpads], pcbComponent?.center?.x ?? 0, pcbComponent?.center?.y ?? 0);
    const image = ensureImage(footprintName);
    const nextPinNumber = createNextPinNumberGenerator(image);
    for (const hole of pcb_plated_holes) {
      const padstackName = ensurePadstack(hole);
      const pcbPort = hole.pcb_port_id ? su4(circuitElements).pcb_port.list().find((e) => e.pcb_port_id === hole.pcb_port_id) : void 0;
      const sourcePort = pcbPort ? su4(circuitElements).source_port.list().find((e) => e.source_port_id === pcbPort.source_port_id) : void 0;
      const pinNumber = findNumericHint(sourcePort) ?? nextPinNumber();
      const pin = {
        padstack_name: padstackName,
        pin_number: pinNumber,
        x: (Number(hole.x.toFixed(3)) - pcbComponent.center.x) * 1e3,
        y: (Number(hole.y.toFixed(3)) - pcbComponent.center.y) * 1e3
      };
      const duplicate = image.pins.some(
        (p) => p.x === pin.x && p.y === pin.y && p.padstack_name === pin.padstack_name
      );
      if (!duplicate) image.pins.push(pin);
    }
    if (pcb_smtpads.length === 0) {
      const key = footprintName;
      if (!componentsByFootprint.has(key)) componentsByFootprint.set(key, []);
      componentsByFootprint.get(key).push({
        componentName: sourceComponent?.name || "Unknown",
        coordinates: applyToPoint2(transformMmToUm2, pcbComponent.center),
        rotation: pcbComponent.rotation || 0,
        value: getComponentValue(sourceComponent),
        sourceComponent
      });
    }
  }
  for (const [footprint, comps] of componentsByFootprint) {
    pcb.placement.components.push({
      name: footprint,
      places: comps.map((c) => ({
        refdes: `${c.componentName}_${c.sourceComponent?.source_component_id}`,
        x: c.coordinates.x,
        y: c.coordinates.y,
        side: "front",
        rotation: c.rotation % 90,
        PN: c.value
      }))
    });
  }
}

// lib/dsn-pcb/circuit-json-to-dsn-json/convert-circuit-json-to-dsn-json.ts
function convertCircuitJsonToDsnJson(circuitElements, options = {}) {
  const pcbBoard = circuitElements.find(
    (element) => element.type === "pcb_board"
  );
  const numLayers = pcbBoard?.num_layers ?? 2;
  const layers = generateLayers(numLayers);
  const layerNames = generateLayerNames(numLayers);
  const defaultViaName = getViaPadstackName(numLayers, 600, 300);
  const pcb = {
    is_dsn_pcb: true,
    filename: "",
    parser: {
      string_quote: "",
      host_version: "",
      space_in_quoted_tokens: "",
      host_cad: ""
    },
    resolution: {
      unit: "um",
      value: 10
    },
    unit: "um",
    structure: {
      layers,
      boundary: {
        path: {
          layer: "pcb",
          width: 0,
          coordinates: calculateBoardBoundary(pcbBoard)
        }
      },
      via: defaultViaName,
      rule: {
        // Default clearance having fallback value
        clearances: [
          {
            value: options.traceClearance ?? 150
          },
          {
            value: 50,
            type: "smd_smd"
          }
        ],
        width: 200
      }
    },
    placement: {
      components: []
    },
    library: {
      images: [],
      padstacks: [
        {
          name: defaultViaName,
          shapes: layerNames.map((name) => ({
            shapeType: "circle",
            layer: name,
            diameter: 600
          })),
          attach: "off"
        }
      ]
    },
    network: {
      nets: [],
      classes: [
        {
          name: "kicad_default",
          description: "",
          net_names: [],
          circuit: {
            use_via: defaultViaName
          },
          rule: {
            // Actual value being used in the dsn for the specific network class
            clearances: [
              {
                value: options.traceClearance ?? 150
                // standard value
              }
            ],
            width: 150
            // trace width used in freerouting
          }
        }
      ]
    },
    wiring: {
      wires: []
    }
  };
  const componentGroups = groupComponents(circuitElements);
  processComponentsAndPads(componentGroups, circuitElements, pcb);
  processPlatedHoles(componentGroups, circuitElements, pcb, numLayers);
  processNets(circuitElements, pcb);
  processPcbTraces(circuitElements, pcb, numLayers);
  return pcb;
}
function calculateBoardBoundary(pcbBoard) {
  const width = pcbBoard?.width ?? 100;
  const height = pcbBoard?.height ?? 100;
  const x = pcbBoard?.center?.x ?? 0;
  const y = pcbBoard?.center?.y ?? 0;
  const halfWidth = width * 1e3 / 2;
  const halfHeight = height * 1e3 / 2;
  const centerX = x * 1e3;
  const centerY = y * 1e3;
  return [
    centerX - halfWidth,
    centerY - halfHeight,
    // Top left
    centerX + halfWidth,
    centerY - halfHeight,
    // Top right
    centerX + halfWidth,
    centerY + halfHeight,
    // Bottom right
    centerX - halfWidth,
    centerY + halfHeight,
    // Bottom left
    centerX - halfWidth,
    centerY - halfHeight
    // Back to top left to close the path
  ];
}
function groupComponents(circuitElements) {
  const componentMap = /* @__PURE__ */ new Map();
  for (const element of circuitElements) {
    if (element.type === "pcb_smtpad" || element.type === "pcb_plated_hole") {
      const componentId = element.pcb_component_id ?? "";
      if (!componentMap.has(componentId)) {
        componentMap.set(componentId, {
          pcb_component_id: componentId,
          pcb_smtpads: [],
          pcb_plated_holes: []
        });
      }
      if (element.type === "pcb_smtpad") {
        componentMap.get(componentId)?.pcb_smtpads.push(element);
      } else if (element.type === "pcb_plated_hole") {
        componentMap.get(componentId)?.pcb_plated_holes.push(element);
      }
    }
  }
  return Array.from(componentMap.values());
}

// lib/dsn-pcb/dsn-json-to-circuit-json/merge-dsn-session-into-dsn-pcb.ts
import Debug2 from "debug";
var debug2 = Debug2("dsn-converter:mergeDsnSessionIntoDsnPcb");
function mergeDsnSessionIntoDsnPcb(dsnPcb, dsnSession) {
  const mergedPcb = JSON.parse(JSON.stringify(dsnPcb));
  if (dsnSession.placement?.components) {
    mergedPcb.placement.components = dsnSession.placement.components;
  }
  if (dsnSession.routes?.network_out?.nets) {
    mergedPcb.wiring.wires = [];
    dsnSession.routes.network_out.nets.forEach((sessionNet) => {
      if (sessionNet.wires) {
        sessionNet.wires.forEach((wire) => {
          debug2("WIRE\n----\n", wire);
          if (wire.path) {
            mergedPcb.wiring.wires.push({
              path: {
                ...wire.path,
                // DsnSession represents the coordinates in ses units, which are
                // 10x larger than the um units used in the DsnPcb files
                coordinates: wire.path.coordinates.map((c) => c / 10)
              },
              net: sessionNet.name,
              type: wire.type ?? "route"
            });
          }
        });
      }
    });
  }
  if (dsnSession.routes?.library_out?.padstacks) {
    const existingPadstackNames = new Set(
      mergedPcb.library.padstacks.map((p) => p.name)
    );
    dsnSession.routes.library_out.padstacks.forEach((padstack) => {
      if (!existingPadstackNames.has(padstack.name)) {
        mergedPcb.library.padstacks.push(padstack);
      }
    });
  }
  return mergedPcb;
}

// lib/dsn-pcb/circuit-json-to-dsn-json/stringify-dsn-json.ts
var stringifyDsnJson = (dsnJson) => {
  const indent = "  ";
  let result = "";
  const stringifyValue = (value) => {
    if (value === null || value === void 0) {
      return '""';
    }
    if (typeof value === "string") {
      return `"${value}"`;
    }
    return value.toString();
  };
  const stringifyCoordinates = (coordinates) => {
    return coordinates.join(" ");
  };
  const stringifyPath = (path, level) => {
    const padding = indent.repeat(level);
    return `${padding}(path ${path.layer} ${path.width}  ${stringifyCoordinates(path.coordinates)})`;
  };
  result += `(pcb ${dsnJson.filename ? dsnJson.filename : "./converted_dsn.dsn"}
`;
  result += `${indent}(parser
`;
  result += `${indent}${indent}(string_quote ")
`;
  result += `${indent}${indent}(space_in_quoted_tokens on)
`;
  result += `${indent}${indent}(host_cad "KiCad's Pcbnew")
`;
  result += `${indent}${indent}(host_version "${dsnJson.parser.host_version}")
`;
  result += `${indent})
`;
  result += `${indent}(resolution ${dsnJson.resolution.unit} ${dsnJson.resolution.value})
`;
  result += `${indent}(unit ${dsnJson.unit})
`;
  result += `${indent}(structure
`;
  dsnJson.structure.layers.forEach((layer) => {
    result += `${indent}${indent}(layer ${layer.name}
`;
    result += `${indent}${indent}${indent}(type ${layer.type})
`;
    result += `${indent}${indent}${indent}(property
`;
    result += `${indent}${indent}${indent}${indent}(index ${layer.property.index})
`;
    result += `${indent}${indent}${indent})
`;
    result += `${indent}${indent})
`;
  });
  if (dsnJson.structure.boundary) {
    result += `${indent}${indent}(boundary
`;
    result += `${indent}${indent}${indent}${stringifyPath(dsnJson.structure.boundary.path, 0)}
`;
    result += `${indent}${indent})
`;
  }
  result += `${indent}${indent}(via ${stringifyValue(dsnJson.structure.via)})
`;
  result += `${indent}${indent}(rule
`;
  result += `${indent}${indent}${indent}(width ${dsnJson.structure.rule.width})
`;
  dsnJson.structure.rule.clearances.forEach((clearance) => {
    result += `${indent}${indent}${indent}(clearance ${clearance.value}${clearance.type ? ` (type ${clearance.type})` : ""})
`;
  });
  result += `${indent}${indent})
`;
  result += `${indent})
`;
  result += `${indent}(placement
`;
  dsnJson.placement.components.forEach((component) => {
    result += `${indent}${indent}(component ${stringifyValue(component.name)}
`;
    if (component.places) {
      component.places.forEach((place) => {
        result += `${indent}${indent}${indent}(place ${place.refdes} ${place.x} ${place.y} ${place.side} ${place.rotation}${place.PN ? ` (PN ${stringifyValue(place.PN)})` : ""})
`;
      });
    }
    result += `${indent}${indent})
`;
  });
  result += `${indent})
`;
  result += `${indent}(library
`;
  dsnJson.library.images.forEach((image) => {
    result += `${indent}${indent}(image ${stringifyValue(image.name)}
`;
    image.outlines.forEach((outline) => {
      result += `${indent}${indent}${indent}(outline ${stringifyPath(outline.path, 4)})
`;
    });
    image.pins.forEach((pin) => {
      result += `${indent}${indent}${indent}(pin ${pin.padstack_name} ${pin.pin_number} ${pin.x} ${pin.y})
`;
    });
    result += `${indent}${indent})
`;
  });
  dsnJson.library.padstacks.forEach((padstack) => {
    result += `${indent}${indent}(padstack ${stringifyValue(padstack.name)}
`;
    padstack.shapes.forEach((shape) => {
      if (shape.shapeType === "polygon") {
        result += `${indent}${indent}${indent}(shape (polygon ${shape.layer} ${shape.width} ${stringifyCoordinates(shape.coordinates)}))
`;
      } else if (shape.shapeType === "circle") {
        result += `${indent}${indent}${indent}(shape (circle ${shape.layer} ${shape.diameter}))
`;
      } else if (shape.shapeType === "path") {
        result += `${indent}${indent}${indent}(shape (path ${shape.layer} ${shape.width} ${stringifyCoordinates(shape.coordinates)}))
`;
      }
    });
    result += `${indent}${indent}${indent}(attach ${padstack.attach})
`;
    result += `${indent}${indent})
`;
  });
  result += `${indent})
`;
  result += `${indent}(network
`;
  dsnJson.network.nets.forEach((net) => {
    result += `${indent}${indent}(net ${stringifyValue(net.name)}
`;
    if (net.pins.length > 0) {
      result += `${indent}${indent}${indent}(pins ${net.pins.join(" ")})
`;
    }
    result += `${indent}${indent})
`;
  });
  dsnJson.network.classes.forEach((cls) => {
    result += `${indent}${indent}(class ${stringifyValue(cls.name)} ${stringifyValue(cls.description)}${cls.net_names.map((n) => ` ${stringifyValue(n)}`).join("")}
`;
    result += `${indent}${indent}${indent}(circuit
`;
    result += `${indent}${indent}${indent}${indent}(use_via ${stringifyValue(cls.circuit.use_via)})
`;
    result += `${indent}${indent}${indent})
`;
    if (cls.rule) {
      result += `${indent}${indent}${indent}(rule
`;
      result += `${indent}${indent}${indent}${indent}(width ${cls.rule.width})
`;
      cls.rule.clearances.forEach((clearance) => {
        result += `${indent}${indent}${indent}${indent}(clearance ${clearance.value}${clearance.type ? ` (type ${clearance.type})` : ""})
`;
      });
      result += `${indent}${indent}${indent})
`;
    }
    result += `${indent}${indent})
`;
  });
  result += `${indent})
`;
  result += `${indent}(wiring
`;
  (dsnJson.wiring?.wires ?? []).forEach((wire) => {
    if (wire.type === "via") {
      result += `${indent}${indent}(via ${stringifyPath(wire.path, 3)}(net ${stringifyValue(wire.net)}))
`;
    } else {
      result += `${indent}${indent}(wire ${stringifyPath(wire.path, 3)}(net ${stringifyValue(wire.net)})(type ${wire.type}))
`;
    }
  });
  result += `${indent})
`;
  result += `)
`;
  return result;
};

// lib/dsn-pcb/circuit-json-to-dsn-json/convert-circuit-json-to-dsn-string.ts
var convertCircuitJsonToDsnString = (circuitJson, options = {}) => {
  const dsnJson = convertCircuitJsonToDsnJson(circuitJson, options);
  return stringifyDsnJson(dsnJson);
};

// lib/dsn-pcb/circuit-json-to-dsn-json/convert-circuit-json-to-dsn-session.ts
function convertCircuitJsonToDsnSession(dsnPcb, circuitJson) {
  const session = {
    is_dsn_session: true,
    filename: dsnPcb.filename || "session",
    placement: {
      resolution: dsnPcb.resolution,
      components: dsnPcb.placement.components
    },
    routes: {
      resolution: dsnPcb.resolution,
      parser: dsnPcb.parser,
      library_out: {
        images: [],
        padstacks: []
      },
      network_out: {
        nets: []
      }
    }
  };
  processPcbTraces(circuitJson, session, dsnPcb.structure.layers.length);
  return session;
}

// lib/dsn-pcb/dsn-json-to-circuit-json/convert-dsn-pcb-to-circuit-json.ts
import { applyToPoint as applyToPoint9, scale as scale3 } from "transformation-matrix";
import { su as su5 } from "@tscircuit/soup-util";

// lib/utils/pairs.ts
var pairs = (array) => {
  const result = [];
  for (let i = 0; i < array.length; i += 2) {
    result.push([array[i], array[i + 1]]);
  }
  return result;
};

// lib/dsn-pcb/dsn-json-to-circuit-json/dsn-component-converters/convert-dsn-pcb-components-to-source-components-and-ports.ts
import { applyToPoint as applyToPoint3 } from "transformation-matrix";
var convertDsnPcbComponentsToSourceComponentsAndPorts = ({
  dsnPcb,
  transformDsnUnitToMm
}) => {
  const result = [];
  const imageMap = new Map(dsnPcb.library.images.map((img) => [img.name, img]));
  for (const component of dsnPcb.placement.components) {
    const image = imageMap.get(component.name);
    if (!image) continue;
    component.places.forEach((place) => {
      const sourceComponent = {
        type: "source_component",
        source_component_id: `sc_${component.name}_${place.refdes}`,
        name: place.refdes,
        display_value: place.PN,
        // Default to simple_chip if no specific type can be determined
        ftype: "simple_chip"
      };
      result.push(sourceComponent);
      if (image.pins) {
        for (const pin of image.pins) {
          const port = {
            type: "source_port",
            source_port_id: `source_port_${component.name}-Pad${pin.pin_number}_${place.refdes}`,
            source_component_id: sourceComponent.source_component_id,
            name: `${place.refdes}-${pin.pin_number}`,
            pin_number: Number(pin.pin_number),
            port_hints: []
          };
          const placeX = place.x || 0;
          const placeY = place.y || 0;
          const pcb_port_center = applyToPoint3(transformDsnUnitToMm, {
            x: placeX + pin.x,
            y: placeY + pin.y
          });
          const pcb_port = {
            pcb_port_id: `pcb_port_${component.name}-Pad${pin.pin_number}_${place.refdes}`,
            type: "pcb_port",
            source_port_id: port.source_port_id,
            pcb_component_id: component.name,
            x: pcb_port_center.x,
            y: pcb_port_center.y,
            layers: [place.side === "back" ? "bottom" : "top"]
          };
          result.push(port, pcb_port);
        }
      }
    });
  }
  return result;
};

// lib/dsn-pcb/dsn-json-to-circuit-json/dsn-component-converters/convert-nets-to-source-nets-and-traces.ts
var convertNetsToSourceNetsAndTraces = ({
  dsnPcb,
  source_ports
}) => {
  const result = [];
  const { nets } = dsnPcb.network;
  let source_trace_id = dsnPcb.wiring.wires.length;
  for (const net of nets) {
    const { name, pins = [] } = net;
    if (!name || name.startsWith("unconnected-")) continue;
    const source_net = {
      type: "source_net",
      name,
      source_net_id: `source_net_${name}`,
      member_source_group_ids: []
    };
    const connected_source_port_ids = [];
    if (pins && pins.length > 0) {
      for (const pin of pins) {
        const source_port = source_ports.find((sp) => sp.name === pin);
        if (source_port) {
          connected_source_port_ids.push(source_port.source_port_id);
        }
      }
    }
    const source_trace = {
      type: "source_trace",
      connected_source_net_ids: [source_net.source_net_id],
      connected_source_port_ids,
      source_trace_id: `source_trace_${source_trace_id}`
    };
    result.push(source_net, source_trace);
    source_trace_id++;
  }
  return result;
};

// lib/dsn-pcb/dsn-json-to-circuit-json/dsn-component-converters/convert-padstacks-to-smtpads.ts
import Debug3 from "debug";
import { applyToPoint as applyToPoint4 } from "transformation-matrix";
var debug3 = Debug3("dsn-converter:convertPadstacksToSmtpads");
var FRONT_COPPER = /* @__PURE__ */ new Set(["F.Cu", "Top", "F_Cu"]);
var BACK_COPPER = /* @__PURE__ */ new Set(["B.Cu", "Bottom", "B_Cu"]);
function isThruHolePadstack(padstack) {
  const layers = padstack.shapes.map((s) => s.layer);
  return layers.some((l) => FRONT_COPPER.has(l)) && layers.some((l) => BACK_COPPER.has(l));
}
function getLayerFromPadstack(padstack) {
  return padstack.shapes[0].layer.includes("B.") || padstack.shapes[0].layer === "Bottom" ? "bottom" : "top";
}
function getPolygonPoints(coordinates, center) {
  const points = [];
  for (let i = 0; i < coordinates.length; i += 2) {
    const point = {
      x: center.x + coordinates[i] / 1e3,
      y: center.y + coordinates[i + 1] / 1e3
    };
    const firstPoint = points[0];
    const isClosingPoint = firstPoint && point.x === firstPoint.x && point.y === firstPoint.y && i === coordinates.length - 2;
    if (!isClosingPoint) {
      points.push(point);
    }
  }
  return points;
}
function getRectangleDimensionsFromPolygon(coordinates) {
  const uniquePoints = /* @__PURE__ */ new Map();
  for (let i = 0; i < coordinates.length; i += 2) {
    const x = coordinates[i];
    const y = coordinates[i + 1];
    uniquePoints.set(`${x},${y}`, { x, y });
  }
  if (uniquePoints.size !== 4) return null;
  const xs = [...new Set([...uniquePoints.values()].map((point) => point.x))];
  const ys = [...new Set([...uniquePoints.values()].map((point) => point.y))];
  if (xs.length !== 2 || ys.length !== 2) return null;
  const corners = new Set(xs.flatMap((x) => ys.map((y) => `${x},${y}`)));
  if ([...uniquePoints.keys()].some((point) => !corners.has(point))) {
    return null;
  }
  return {
    width: Math.abs(xs[1] - xs[0]) / 1e3,
    height: Math.abs(ys[1] - ys[0]) / 1e3
  };
}
function isApproximatelyEqual(a, b) {
  return Math.abs(a - b) < 1e-6;
}
function convertPadstacksToSmtPads(pcb, dsnToCircuitJsonTransform) {
  const elements = [];
  const { padstacks, images } = pcb.library;
  debug3("processing padstacks...");
  images.forEach((image) => {
    const componentId = image.name;
    const placementComponent = pcb.placement.components.find(
      (comp) => comp.name === componentId
    );
    if (!placementComponent) {
      console.warn(`No placement component found for image: ${componentId}`);
      return;
    }
    placementComponent.places.forEach((place) => {
      debug3("processing place...", { place });
      const { x: compX, y: compY, side } = place;
      image.pins.forEach((pin) => {
        const padstack = padstacks.find((p) => p.name === pin.padstack_name);
        debug3("found padstack", { padstack });
        if (!padstack) {
          console.warn(`No padstack found for pin: ${pin.padstack_name}`);
          return;
        }
        const { x: circuitX, y: circuitY } = applyToPoint4(
          dsnToCircuitJsonTransform,
          {
            x: (compX || 0) + pin.x,
            y: (compY || 0) + pin.y
          }
        );
        const commonIds = {
          pcb_component_id: `${componentId}_${place.refdes}`,
          pcb_port_id: `pcb_port_${componentId}-Pad${pin.pin_number}_${place.refdes}`,
          port_hints: [pin.pin_number.toString()]
        };
        const pcbPlatedHoleId = `pcb_plated_hole_${componentId}_${place.refdes}_${pin.pin_number}`;
        const parsedPadstackName = parsePadstackName(padstack.name);
        if (isThruHolePadstack(padstack)) {
          const circleShape2 = padstack.shapes.find(
            (s) => s.shapeType === "circle"
          );
          const pathShape2 = padstack.shapes.find((s) => s.shapeType === "path");
          if (circleShape2 && circleShape2.shapeType === "circle") {
            const outerDiameter = circleShape2.diameter / 1e3;
            const holeDiameter = padstack.hole?.diameter !== void 0 ? padstack.hole.diameter / 1e3 : parsedPadstackName?.shape === "circle" ? parsedPadstackName.holeDiameter : outerDiameter * 0.6;
            const platedHole = {
              type: "pcb_plated_hole",
              pcb_plated_hole_id: pcbPlatedHoleId,
              ...commonIds,
              shape: "circle",
              x: circuitX,
              y: circuitY,
              outer_diameter: outerDiameter,
              hole_diameter: holeDiameter,
              layers: ["top", "bottom"]
            };
            elements.push(platedHole);
            return;
          }
          if (pathShape2 && pathShape2.shapeType === "path") {
            const [x1, y1, x2, y2] = pathShape2.coordinates;
            const strokeWidth = pathShape2.width / 1e3;
            const endpointDist = Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2) / 1e3;
            const isHorizontal = Math.abs(x2 - x1) >= Math.abs(y2 - y1);
            const major = endpointDist + strokeWidth;
            const minor = strokeWidth;
            const outerWidth = isHorizontal ? major : minor;
            const outerHeight = isHorizontal ? minor : major;
            let holeWidth;
            let holeHeight;
            if (padstack.hole?.width !== void 0) {
              holeWidth = padstack.hole.width / 1e3;
              holeHeight = (padstack.hole.height ?? padstack.hole.width) / 1e3;
            } else {
              const parsedNameMatchesOuterDimensions = parsedPadstackName?.shape === "oval" && isApproximatelyEqual(parsedPadstackName.width, outerWidth) && isApproximatelyEqual(parsedPadstackName.height, outerHeight);
              if (parsedPadstackName?.shape === "oval" && !parsedNameMatchesOuterDimensions) {
                holeWidth = parsedPadstackName.width;
                holeHeight = parsedPadstackName.height;
              } else {
                holeWidth = outerWidth * 0.6;
                holeHeight = outerHeight * 0.6;
              }
            }
            const platedHole = {
              type: "pcb_plated_hole",
              pcb_plated_hole_id: pcbPlatedHoleId,
              ...commonIds,
              shape: "oval",
              x: circuitX,
              y: circuitY,
              outer_width: outerWidth,
              outer_height: outerHeight,
              hole_width: holeWidth,
              hole_height: holeHeight,
              ccw_rotation: 0,
              layers: ["top", "bottom"]
            };
            elements.push(platedHole);
            return;
          }
        }
        const rectShape = padstack.shapes.find((s) => s.shapeType === "rect");
        const polygonShape = padstack.shapes.find(
          (s) => s.shapeType === "polygon"
        );
        const circleShape = padstack.shapes.find(
          (s) => s.shapeType === "circle"
        );
        const pathShape = padstack.shapes.find((s) => s.shapeType === "path");
        debug3("found shapes", {
          rectShape,
          polygonShape,
          circleShape,
          pathShape
        });
        let width;
        let height;
        if (rectShape) {
          const [x1, y1, x2, y2] = rectShape.coordinates;
          width = Math.abs(x2 - x1) / 1e3;
          height = Math.abs(y2 - y1) / 1e3;
        } else if (polygonShape) {
          const coordinates = polygonShape.coordinates;
          let minX = Infinity;
          let maxX = -Infinity;
          let minY = Infinity;
          let maxY = -Infinity;
          for (let i = 0; i < coordinates.length; i += 2) {
            const x = coordinates[i];
            const y = coordinates[i + 1];
            minX = Math.min(minX, x);
            maxX = Math.max(maxX, x);
            minY = Math.min(minY, y);
            maxY = Math.max(maxY, y);
          }
          width = Math.abs(maxX - minX) / 1e3;
          height = Math.abs(maxY - minY) / 1e3;
        } else if (pathShape) {
          const [x1, y1, x2, y2] = pathShape.coordinates;
          width = pathShape.width / 1e3;
          height = Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2) / 1e3;
        } else if (circleShape) {
          const radius = circleShape.diameter / 2 / 1e3;
          width = radius;
          height = radius;
        } else {
          console.warn(`No valid shape found for padstack: ${padstack.name}`);
          return;
        }
        let pcbPad;
        const rectangleDimensionsFromPolygon = polygonShape ? getRectangleDimensionsFromPolygon(polygonShape.coordinates) : null;
        const shouldImportPolygonAsRect = !!polygonShape && !!rectangleDimensionsFromPolygon;
        if (polygonShape && !shouldImportPolygonAsRect) {
          const layer = getLayerFromPadstack(padstack);
          pcbPad = {
            type: "pcb_smtpad",
            pcb_smtpad_id: `pcb_smtpad_${componentId}_${place.refdes}_${Number(pin.pin_number) - 1}`,
            ...commonIds,
            shape: "polygon",
            points: getPolygonPoints(polygonShape.coordinates, {
              x: circuitX,
              y: circuitY
            }),
            layer
          };
        } else if (rectShape || pathShape || shouldImportPolygonAsRect) {
          const layer = getLayerFromPadstack(padstack);
          pcbPad = {
            type: "pcb_smtpad",
            pcb_smtpad_id: `pcb_smtpad_${componentId}_${place.refdes}_${Number(pin.pin_number) - 1}`,
            ...commonIds,
            shape: "rect",
            x: circuitX,
            y: circuitY,
            width: rectangleDimensionsFromPolygon?.width ?? width,
            height: rectangleDimensionsFromPolygon?.height ?? height,
            layer
          };
        } else {
          pcbPad = {
            type: "pcb_smtpad",
            pcb_smtpad_id: `pcb_smtpad_${componentId}_${place.refdes}_${Number(pin.pin_number) - 1}`,
            ...commonIds,
            shape: "circle",
            x: circuitX,
            y: circuitY,
            radius: circleShape.diameter / 2 / 1e3,
            layer: side === "front" ? "top" : "bottom"
          };
        }
        elements.push(pcbPad);
      });
    });
  });
  return elements;
}

// lib/dsn-pcb/dsn-json-to-circuit-json/dsn-component-converters/convert-wires-to-traces.ts
import Debug6 from "debug";
import "transformation-matrix";

// lib/utils/chunks.ts
var chunks = (array, size) => {
  const result = [];
  for (let i = 0; i < array.length; i += size) {
    result.push(array.slice(i, i + size));
  }
  return result;
};

// lib/utils/compute-seg-intersection.ts
var computeSegIntersection = (seg1, seg2) => {
  const v1x = seg1.x2 - seg1.x1;
  const v1y = seg1.y2 - seg1.y1;
  const v2x = seg2.x2 - seg2.x1;
  const v2y = seg2.y2 - seg2.y1;
  const cross = v1x * v2y - v1y * v2x;
  if (Math.abs(cross) < 1e-8) {
    console.log("lines are parallel");
    return null;
  }
  const t = ((seg2.x1 - seg1.x1) * v2y - (seg2.y1 - seg1.y1) * v2x) / cross;
  const s = ((seg2.x1 - seg1.x1) * v1y - (seg2.y1 - seg1.y1) * v1x) / cross;
  return {
    x: seg1.x1 + t * v1x,
    y: seg1.y1 + t * v1y
  };
};

// lib/utils/get-trace-length.ts
function getTraceLength(points) {
  let length = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const dx = points[i + 1].x - points[i].x;
    const dy = points[i + 1].y - points[i].y;
    length += Math.sqrt(dx * dx + dy * dy);
  }
  return Number(length.toFixed(4));
}

// lib/dsn-pcb/dsn-json-to-circuit-json/dsn-component-converters/convert-polyline-path-to-pcb-traces.ts
import { applyToPoint as applyToPoint5 } from "transformation-matrix";
var convertPolylinePathToPcbTraces = ({
  wire,
  transformUmToMm,
  netName,
  fromSessionSpace = true
}) => {
  const traces = [];
  const segsUm = chunks(wire.polyline_path.coordinates, 4).map(
    ([x1, y1, x2, y2]) => ({ x1, y1, x2, y2 })
  );
  const pointsOnTraceMm = [];
  for (let i = 0; i < segsUm.length - 1; i++) {
    const intersection = computeSegIntersection(segsUm[i], segsUm[i + 1]);
    if (!intersection) continue;
    pointsOnTraceMm.push(applyToPoint5(transformUmToMm, intersection));
  }
  traces.push({
    type: "pcb_trace",
    pcb_trace_id: `pcb_trace_${netName}`,
    source_trace_id: netName,
    route: pointsOnTraceMm.map((point) => ({
      route_type: "wire",
      x: Number(point.x.toFixed(4)),
      y: Number(point.y.toFixed(4)),
      width: fromSessionSpace ? wire.polyline_path.width / 1e4 : wire.polyline_path.width / 1e3,
      // dsn space to circuit space
      layer: /^In(\d+)/.test(String(wire.polyline_path?.layer)) ? "inner" + String(wire.polyline_path?.layer).match(/^In(\d+)/)[1] : wire.polyline_path?.layer.includes("B.") ? "bottom" : "top"
    })),
    trace_length: getTraceLength(pointsOnTraceMm)
  });
  return traces;
};

// lib/dsn-pcb/dsn-json-to-circuit-json/dsn-component-converters/convert-wiring-path-to-pcb-traces.ts
import Debug4 from "debug";
import { applyToPoint as applyToPoint6 } from "transformation-matrix";
var debug4 = Debug4("dsn-converter:convertWiringPathToPcbTraces");
var convertWiringPathToPcbTraces = ({
  wire,
  transformUmToMm,
  netName,
  fromSessionSpace = true
}) => {
  const coordinates = wire.path.coordinates;
  const points = [];
  for (let i = 0; i < coordinates.length; i += 2) {
    const x = coordinates[i];
    const y = coordinates[i + 1];
    if (x !== void 0 && y !== void 0) {
      const circuitPoint = applyToPoint6(transformUmToMm, { x, y });
      points.push(circuitPoint);
    }
  }
  if (points.length >= 2) {
    const routePoints = points.map((point) => ({
      route_type: "wire",
      x: Number(point.x.toFixed(4)),
      y: Number(point.y.toFixed(4)),
      width: fromSessionSpace ? wire.path.width / 1e4 : wire.path.width / 1e3,
      // dsn space to circuit space
      layer: /^In(\d+)/.test(String(wire.path.layer)) ? "inner" + String(wire.path.layer).match(/^In(\d+)/)[1] : wire.path.layer.includes("F.") ? "top" : "bottom"
    }));
    const pcbTrace = {
      type: "pcb_trace",
      pcb_trace_id: `pcb_trace_${netName}`,
      source_trace_id: netName.split("-")[0],
      route: routePoints,
      trace_length: getTraceLength(routePoints)
    };
    const sourceTrace = {
      type: "source_trace",
      source_trace_id: netName.split("--")[0],
      connected_source_net_ids: [],
      connected_source_port_ids: netName.split("--").slice(1)
    };
    return [pcbTrace, sourceTrace];
  }
  return [];
};

// lib/dsn-pcb/dsn-json-to-circuit-json/dsn-component-converters/convert-wiring-via-to-pcb-vias.ts
import Debug5 from "debug";
import { applyToPoint as applyToPoint7 } from "transformation-matrix";
var debug5 = Debug5("dsn-converter:convertWiringViaToPcbVias");
var convertWiringViaToPcbVias = ({
  wire,
  transformUmToMm,
  netName
}) => {
  if (!wire.path?.coordinates || wire.path.coordinates.length < 2) {
    debug5("Couldn't create via");
    return [];
  }
  const [x, y] = wire.path.coordinates;
  const circuitPoint = applyToPoint7(transformUmToMm, { x, y });
  const via = {
    type: "pcb_via",
    layers: ["top", "bottom"],
    pcb_via_id: `pcb_via_${netName}`,
    x: Number(circuitPoint.x.toFixed(4)),
    y: Number(circuitPoint.y.toFixed(4)),
    // TODO look up via size
    outer_diameter: 0.6,
    // Standard via diameter in mm
    hole_diameter: 0.3
    // Standard drill diameter in mm
  };
  debug5("Created via", via);
  return [via];
};

// lib/dsn-pcb/dsn-json-to-circuit-json/dsn-component-converters/convert-wires-to-traces.ts
var debug6 = Debug6("dsn-converter:convertWiresToPcbTraces");
function convertWiresToPcbTraces(wiring, network, transformUmToMm, fromSessionSpace) {
  const tracesAndVias = [];
  const processedNets = /* @__PURE__ */ new Set();
  wiring.wires?.forEach((wire) => {
    debug6("WIRE\n----\n", wire);
    const netName = wire.net;
    if (!netName) return;
    if (wire.type === "shove_fixed") {
      return;
    }
    if (processedNets.has(netName)) {
      debug6(
        `Already processed wire for net "${netName}" but got another (hopefully not a duplicate wire!)`
      );
    }
    processedNets.add(netName);
    if (wire.type === "via") {
      debug6("wire is actually a via!");
      tracesAndVias.push(
        ...convertWiringViaToPcbVias({ wire, transformUmToMm, netName })
      );
      return;
    }
    if ("polyline_path" in wire) {
      tracesAndVias.push(
        ...convertPolylinePathToPcbTraces({
          wire,
          transformUmToMm,
          netName,
          fromSessionSpace
        })
      );
      return;
    }
    if ("path" in wire) {
      tracesAndVias.push(
        ...convertWiringPathToPcbTraces({
          wire,
          transformUmToMm,
          netName,
          fromSessionSpace
        })
      );
      return;
    }
  });
  return tracesAndVias;
}

// lib/dsn-pcb/dsn-json-to-circuit-json/convert-dsn-pcb-to-circuit-json.ts
function convertDsnPcbToCircuitJson(dsnPcb, fromSessionSpace = false) {
  const elements = [];
  const transformDsnUnitToMm = scale3(1 / 1e3);
  const board = {
    type: "pcb_board",
    pcb_board_id: "pcb_board_0",
    center: { x: 0, y: 0 },
    width: 10,
    height: 10,
    thickness: 1.4,
    material: "fr4",
    num_layers: 4
  };
  if (dsnPcb.structure.boundary.path) {
    const boundaryPath = pairs(dsnPcb.structure.boundary.path.coordinates);
    const maxX = Math.max(...boundaryPath.map(([x]) => x));
    const minX = Math.min(...boundaryPath.map(([x]) => x));
    const maxY = Math.max(...boundaryPath.map(([, y]) => y));
    const minY = Math.min(...boundaryPath.map(([, y]) => y));
    board.center = applyToPoint9(transformDsnUnitToMm, {
      x: (maxX + minX) / 2,
      y: (maxY + minY) / 2
    });
    board.width = (maxX - minX) * transformDsnUnitToMm.a;
    board.height = (maxY - minY) * transformDsnUnitToMm.a;
  } else {
    throw new Error(
      `Couldn't read DSN boundary, add support for dsnPcb.structure.boundary["${Object.keys(dsnPcb.structure.boundary).join(",")}"]`
    );
  }
  elements.push(board);
  elements.push(...convertPadstacksToSmtPads(dsnPcb, transformDsnUnitToMm));
  if (dsnPcb.wiring && dsnPcb.network) {
    elements.push(
      ...convertWiresToPcbTraces(
        dsnPcb.wiring,
        dsnPcb.network,
        transformDsnUnitToMm,
        fromSessionSpace
      )
    );
  }
  elements.push(
    ...convertDsnPcbComponentsToSourceComponentsAndPorts({
      dsnPcb,
      transformDsnUnitToMm
    })
  );
  elements.push(
    ...convertNetsToSourceNetsAndTraces({
      dsnPcb,
      source_ports: su5(elements).source_port.list()
    })
  );
  return elements;
}

// lib/dsn-pcb/circuit-json-to-dsn-json/stringify-dsn-session.ts
var stringifyDsnSession = (session) => {
  const indent = "  ";
  let result = "";
  result += `(session ${session.filename}
`;
  result += `${indent}(base_design ${session.filename})
`;
  result += `${indent}(placement
`;
  result += `${indent}${indent}(resolution ${session.placement.resolution.unit} ${session.placement.resolution.value})
`;
  session.placement.components.forEach((component) => {
    result += `${indent}${indent}(component ${component.name}
`;
    component.places.forEach((place) => {
      result += `${indent}${indent}${indent}(place ${place.refdes} ${place.x} ${place.y} ${place.side} ${place.rotation})
`;
    });
    result += `${indent}${indent})
`;
  });
  result += `${indent})
`;
  result += `${indent}(was_is
${indent})
`;
  result += `${indent}(routes 
`;
  result += `${indent}${indent}(resolution ${session.routes.resolution.unit} ${session.routes.resolution.value})
`;
  result += `${indent}${indent}(parser
`;
  result += `${indent}${indent}${indent}(host_cad ${JSON.stringify(session.routes.parser.host_cad)})
`;
  result += `${indent}${indent}${indent}(host_version ${JSON.stringify(session.routes.parser.host_version)})
`;
  result += `${indent}${indent})
`;
  if (session.routes.library_out) {
    result += `${indent}${indent}(library_out 
`;
    session.routes.library_out.padstacks.forEach((padstack) => {
      result += `${indent}${indent}${indent}(padstack ${JSON.stringify(padstack.name)}
`;
      padstack.shapes.forEach((shape) => {
        if (shape.shapeType === "circle") {
          result += `${indent}${indent}${indent}${indent}(shape
`;
          result += `${indent}${indent}${indent}${indent}${indent}(circle ${shape.layer} ${shape.diameter} 0 0)
`;
          result += `${indent}${indent}${indent}${indent})
`;
        }
      });
      result += `${indent}${indent}${indent}${indent}(attach ${padstack.attach})
`;
      result += `${indent}${indent}${indent})
`;
    });
    result += `${indent}${indent})
`;
  }
  result += `${indent}${indent}(network_out 
`;
  session.routes.network_out.nets.forEach((net) => {
    result += `${indent}${indent}${indent}(net ${JSON.stringify(net.name)}
`;
    net.wires.forEach((wire) => {
      if (wire.path) {
        result += `${indent}${indent}${indent}${indent}(wire
`;
        result += `${indent}${indent}${indent}${indent}${indent}(path ${wire.path.layer} ${wire.path.width}
`;
        result += `${indent}${indent}${indent}${indent}${indent}${indent}${wire.path.coordinates.join(" ")}
`;
        result += `${indent}${indent}${indent}${indent}${indent})
`;
        result += `${indent}${indent}${indent}${indent})
`;
      }
    });
    result += `${indent}${indent}${indent})
`;
  });
  result += `${indent}${indent})
`;
  result += `${indent})
`;
  result += `)
`;
  return result;
};

// lib/dsn-pcb/dsn-json-to-circuit-json/convert-dsn-json-to-circuit-json.ts
import "transformation-matrix";

// lib/dsn-pcb/dsn-json-to-circuit-json/convert-dsn-session-to-circuit-json.ts
import { su as su6 } from "@tscircuit/soup-util";
import Debug7 from "debug";
import { applyToPoint as applyToPoint11, scale as scale4 } from "transformation-matrix";

// lib/dsn-pcb/dsn-json-to-circuit-json/dsn-component-converters/convert-via-to-pcb-via.ts
import "transformation-matrix";
var convertViaToPcbVia = ({
  x,
  y,
  netName,
  fromLayer,
  toLayer
}) => {
  return {
    type: "pcb_via",
    pcb_via_id: `pcb_via_${netName}_${x}_${y}`,
    x,
    y,
    outer_diameter: 0.6,
    // From session file "Via[0-1]_600:300_um"
    hole_diameter: 0.3,
    // From session file "Via[0-1]_600:300_um"
    layers: [fromLayer, toLayer],
    pcb_trace_id: `pcb_trace_${netName}`,
    from_layer: fromLayer,
    to_layer: toLayer
  };
};

// lib/dsn-pcb/dsn-json-to-circuit-json/convert-dsn-session-to-circuit-json.ts
var debug7 = Debug7("dsn-converter");
function hasCoordinatePosition2(point) {
  return point.route_type === "wire" || point.route_type === "via";
}
function convertDsnSessionToCircuitJson(dsnInput, dsnSession, circuitJson) {
  const transformUmToMm = scale4(1 / 1e4);
  const inputPcbElms = convertDsnPcbToCircuitJson(
    dsnInput,
    true
    // from session space to circuit space
  );
  const existingSourceTraces = inputPcbElms.filter(
    (elm) => elm.type === "source_trace"
  );
  if (circuitJson) {
    existingSourceTraces.forEach((st) => {
      for (const portId of st.connected_source_port_ids) {
        const [pad_number, source_port_component_name] = portId.split("-").pop()?.split("_") ?? [];
        const pin_number = parseInt(pad_number.replace("Pad", ""));
        const source_port_component = su6(circuitJson).source_component.list().find((elm) => elm.name === source_port_component_name);
        const source_ports = su6(circuitJson).source_port.list().filter(
          (elm) => elm.source_component_id === source_port_component?.source_component_id && elm.pin_number === pin_number
        );
        const source_trace = su6(circuitJson).source_trace.list().find(
          (elm) => elm.connected_source_port_ids.some(
            (id) => source_ports.some((sp) => sp.source_port_id === id)
          )
        );
        if (source_trace) {
          st.source_trace_id = source_trace.source_trace_id;
          break;
        }
      }
      if (!st.source_trace_id) {
        st.source_trace_id = `source_trace_${st.connected_source_port_ids[0]}`;
      }
    });
  }
  const sessionElements = [];
  for (const net of dsnSession.routes.network_out.nets) {
    const sourceTrace = existingSourceTraces.find((st) => {
      const sourceNetIds = st.connected_source_net_ids || [];
      const sourceNet = inputPcbElms.find(
        (elm) => elm.type === "source_net" && elm.name === net.name && sourceNetIds.includes(elm.source_net_id)
      );
      return sourceNet !== void 0;
    });
    net.wires?.forEach((wire, wireIdx) => {
      if ("path" in wire) {
        const traces = convertWiringPathToPcbTraces({
          wire,
          transformUmToMm,
          netName: `${net.name}_${wireIdx}`
        });
        traces.forEach((trace) => {
          trace.source_trace_id = sourceTrace ? sourceTrace.source_trace_id : `source_trace_${net.name}`;
        });
        sessionElements.push(...traces);
      }
    });
    const viaPadstackExists = dsnSession.routes.library_out?.padstacks?.find(
      (p) => p.name === "Via[0-1]_600:300_um"
    );
    if (viaPadstackExists && net.vias && net.vias.length > 0) {
      net.vias.forEach((via) => {
        const viaPoint = applyToPoint11(transformUmToMm, {
          x: via.x,
          y: via.y
        });
        const viaX = Number(viaPoint.x.toFixed(4));
        const viaY = Number(viaPoint.y.toFixed(4));
        const connectingWires = sessionElements.flatMap(
          (segment) => segment.type === "pcb_trace" ? segment.route.flatMap(
            (point) => point.route_type === "wire" ? [
              {
                ...point,
                x: Number(point.x.toFixed(4)),
                y: Number(point.y.toFixed(4))
              }
            ] : []
          ) : []
        ).filter(
          (point) => point.route_type === "wire" && point.x === viaX && point.y === viaY
        );
        const fromLayer = connectingWires[0]?.layer || "top";
        const toLayer = connectingWires[1]?.layer || "bottom";
        let viaAdded = false;
        for (const element of sessionElements) {
          if (viaAdded) break;
          if (element.type === "pcb_trace") {
            const trace = element;
            for (let i = 0; i < trace.route.length; i++) {
              const point = trace.route[i];
              if (!hasCoordinatePosition2(point)) continue;
              if (point.x === viaX && point.y === viaY) {
                trace.route.splice(i + 1, 0, {
                  x: viaX,
                  y: viaY,
                  route_type: "via",
                  from_layer: fromLayer,
                  to_layer: toLayer
                });
                viaAdded = true;
                break;
              }
            }
          }
        }
        sessionElements.push({
          ...convertViaToPcbVia({
            x: viaX,
            y: viaY,
            netName: net.name,
            fromLayer,
            toLayer
          })
        });
      });
    }
  }
  return [...inputPcbElms, ...sessionElements];
}

// lib/dsn-pcb/dsn-json-to-circuit-json/convert-dsn-json-to-circuit-json.ts
function convertDsnJsonToCircuitJson(dsnPcb) {
  return convertDsnPcbToCircuitJson(dsnPcb);
}

// lib/dsn-pcb/dsn-json-to-circuit-json/parse-dsn-to-dsn-json.ts
import Debug10 from "debug";

// lib/utils/get-pin-number.ts
import Debug8 from "debug";
var debug8 = Debug8("dsn-converter:getPinNum");
function getPinNum(nodes) {
  let pinNumber;
  if (nodes[2]?.type === "List" && nodes[2].children) {
    pinNumber = nodes[2].children[0]?.value;
  } else if (nodes[2]?.type === "Atom") {
    pinNumber = nodes[2].value;
  } else {
    debug8("Unsupported pin number format:", nodes);
    return null;
  }
  if (typeof pinNumber === "number") {
    return pinNumber;
  }
  const parsed = parseInt(String(pinNumber), 10);
  return Number.isNaN(parsed) ? String(pinNumber) : parsed;
}

// lib/utils/get-via-coordinates.ts
import Debug9 from "debug";
var debug9 = Debug9("dsn-converter:getViaCoords");
function getViaCoords(nodes) {
  try {
    if (nodes[2]?.type === "Atom" && typeof nodes[2].value === "number" && nodes[3]?.type === "Atom" && typeof nodes[3].value === "number") {
      return {
        x: nodes[2].value,
        y: nodes[3].value
      };
    }
    const pathNode = nodes.find(
      (node) => node.type === "List" && node.children?.[0]?.type === "Atom" && node.children[0].value === "path"
    );
    if (pathNode?.children) {
      const coords = pathNode.children.filter(
        (node) => node.type === "Atom" && typeof node.value === "number"
      ).slice(-2);
      if (coords.length === 2) {
        return {
          x: coords[0].value,
          y: coords[1].value
        };
      }
    }
    debug9("Could not extract coordinates from via nodes:", nodes);
    return null;
  } catch (error) {
    debug9("Error extracting via coordinates:", error);
    return null;
  }
}

// lib/common/parse-sexpr.ts
function tokenizeDsn(input) {
  const tokens = [];
  let i = 0;
  const length = input.length;
  while (i < length) {
    const char = input[i];
    if (char === "(") {
      tokens.push({ type: "LParen" });
      i++;
    } else if (char === ")") {
      tokens.push({ type: "RParen" });
      i++;
    } else if (/\s/.test(char)) {
      i++;
    } else if (char === '"') {
      let value = "";
      i++;
      while (i < length && input[i] !== '"') {
        if (input[i] === "\\") {
          i++;
          if (i < length) {
            value += input[i];
            i++;
          }
        } else {
          value += input[i];
          i++;
        }
      }
      i++;
      tokens.push({ type: "String", value });
    } else if (char === "-" || /\d/.test(char)) {
      let numStr = "";
      if (char === "-") {
        numStr += "-";
        i++;
      }
      while (i < length && /[\d.]/.test(input[i])) {
        numStr += input[i];
        i++;
      }
      tokens.push({ type: "Number", value: parseFloat(numStr) });
    } else {
      let sym = "";
      while (i < length && !/\s|\(|\)/.test(input[i])) {
        sym += input[i];
        i++;
      }
      tokens.push({ type: "Symbol", value: sym });
    }
  }
  return tokens;
}
function parseSexprToAst(tokens) {
  let i = 0;
  function parseExpression() {
    const token = tokens[i];
    if (!token) {
      throw new Error("Unexpected end of input");
    }
    if (token.type === "LParen") {
      i++;
      const node = { type: "List", children: [] };
      while (i < tokens.length && tokens[i].type !== "RParen") {
        node.children.push(parseExpression());
      }
      if (tokens[i]?.type !== "RParen") {
        throw new Error('Expected ")"');
      }
      i++;
      return node;
    } else if (token.type === "Symbol" || token.type === "String" || token.type === "Number") {
      i++;
      return { type: "Atom", value: token.value };
    } else {
      throw new Error(`Unexpected token: ${JSON.stringify(token)}`);
    }
  }
  const ast = parseExpression();
  if (i < tokens.length) {
    throw new Error("Unexpected tokens after end of expression");
  }
  return ast;
}

// lib/dsn-pcb/dsn-json-to-circuit-json/parse-dsn-to-dsn-json.ts
var debug10 = Debug10("dsn-converter:parse-dsn-to-dsn-json");
function parseDsnToDsnJson(dsnString) {
  const tokens = tokenizeDsn(dsnString);
  const ast = parseSexprToAst(tokens);
  if (ast.type === "List" && ast.children && ast.children[0].type === "Atom") {
    const rootNode = ast.children[0].value;
    if (rootNode === "session") {
      const session = processSessionNode(ast);
      return session;
    } else if (rootNode === "pcb") {
      const pcb = processPcbNode(ast);
      return pcb;
    }
  }
  throw new Error("Invalid DSN file format");
}
function processPcbNode(node) {
  if (node.type === "List") {
    const [head, ...tail] = node.children;
    if (head.type === "Atom" && typeof head.value === "string") {
      switch (head.value) {
        case "session":
          return processSessionNode(node);
        case "pcb":
          return processPCB(tail);
        case "parser":
          return processParser(tail);
        case "resolution":
          return processResolution(node.children);
        case "unit":
          return node.children[1].value;
        case "structure":
          return processStructure(tail);
        case "placement":
          return processPlacement(tail);
        case "library":
          return processLibrary(tail);
        case "network":
          return processNetwork(tail);
        case "wiring":
          return processWiring(tail);
        default:
          return null;
      }
    }
  }
  return null;
}
function processPCB(nodes) {
  const pcb = {
    is_dsn_pcb: true,
    wiring: { wires: [] }
  };
  const filenameNode = nodes[0];
  if (filenameNode.type === "Atom" && typeof filenameNode.value === "string") {
    pcb.filename = filenameNode.value;
  } else {
    throw new Error("Expected filename in pcb definition");
  }
  for (let i = 1; i < nodes.length; i++) {
    const element = nodes[i];
    if (element.type === "List") {
      const [keyNode, ...rest] = element.children;
      if (keyNode.type === "Atom" && typeof keyNode.value === "string") {
        const key = keyNode.value;
        switch (key) {
          case "parser":
            pcb.parser = processParser(element.children.slice(1));
            break;
          case "resolution":
            pcb.resolution = processResolution(element.children);
            break;
          case "unit":
            if (element.children[1].type === "Atom" && typeof element.children[1].value === "string") {
              pcb.unit = element.children[1].value;
            }
            break;
          case "structure":
            pcb.structure = processStructure(element.children.slice(1));
            break;
          case "placement":
            pcb.placement = processPlacement(element.children.slice(1));
            break;
          case "library":
            pcb.library = processLibrary(element.children.slice(1));
            break;
          case "network":
            pcb.network = processNetwork(element.children.slice(1));
            break;
          case "wiring":
            pcb.wiring = processWiring(element.children.slice(1));
            break;
        }
      }
    }
  }
  return pcb;
}
function processParser(nodes) {
  const parser = {};
  nodes.forEach((node) => {
    if (node.type === "List" && node.children && node.children.length >= 2) {
      const [keyNode, valueNode] = node.children;
      if (keyNode?.type === "Atom" && typeof keyNode.value === "string" && valueNode?.type === "Atom" && (typeof valueNode.value === "string" || typeof valueNode.value === "number")) {
        const key = keyNode.value;
        const value = valueNode.value;
        switch (key) {
          case "string_quote":
            if (typeof value === "string") parser.string_quote = value;
            break;
          case "space_in_quoted_tokens":
            if (typeof value === "string") parser.space_in_quoted_tokens = value;
            break;
          case "host_cad":
            if (typeof value === "string") parser.host_cad = value;
            break;
          case "host_version":
            if (typeof value === "string") parser.host_version = value;
            break;
        }
      }
    }
  });
  return parser;
}
function processResolution(nodes) {
  const [_, unitNode, valueNode] = nodes;
  if (unitNode.type === "Atom" && typeof unitNode.value === "string" && valueNode.type === "Atom" && typeof valueNode.value === "number") {
    return {
      unit: unitNode.value,
      value: valueNode.value
    };
  } else {
    throw new Error("Invalid resolution format");
  }
}
function processStructure(nodes) {
  const structure = {
    layers: []
  };
  nodes.forEach((node) => {
    if (node.type === "List") {
      const [keyNode, ...rest] = node.children;
      if (keyNode.type === "Atom" && typeof keyNode.value === "string") {
        const key = keyNode.value;
        switch (key) {
          case "layer":
            structure.layers.push(processLayer(node.children));
            break;
          case "boundary":
            structure.boundary = processBoundary(node.children.slice(1));
            break;
          case "via":
            if (node.children[1].type === "Atom" && typeof node.children[1].value === "string") {
              structure.via = node.children[1].value;
            }
            break;
          case "rule":
            structure.rule = processRule(node.children.slice(1));
            break;
        }
      }
    }
  });
  return structure;
}
function processLayer(nodes) {
  const layer = {};
  if (nodes[1].type === "Atom" && typeof nodes[1].value === "string") {
    layer.name = nodes[1].value;
  }
  nodes.slice(2).forEach((node) => {
    if (node.type === "List") {
      const [keyNode, ...rest] = node.children;
      if (keyNode.type === "Atom" && typeof keyNode.value === "string") {
        const key = keyNode.value;
        switch (key) {
          case "type":
            if (rest[0].type === "Atom" && typeof rest[0].value === "string") {
              layer.type = rest[0].value;
            }
            break;
          case "property":
            layer.property = processProperty(rest);
            break;
        }
      }
    }
  });
  return layer;
}
function processProperty(nodes) {
  const property = {};
  nodes.forEach((node) => {
    if (node.type === "List") {
      const [keyNode, valueNode] = node.children;
      if (keyNode.type === "Atom" && typeof keyNode.value === "string" && valueNode.type === "Atom" && typeof valueNode.value === "number") {
        if (keyNode.value === "index") {
          property.index = valueNode.value;
        }
      }
    }
  });
  return property;
}
function processBoundary(nodes) {
  const boundary = {};
  nodes.forEach((node) => {
    if (node.type === "List" && node.children[0].type === "Atom") {
      boundary.path = processPath(node.children);
    }
  });
  if (!boundary.path) {
    boundary.path = { layer: "", width: 0, coordinates: [] };
  }
  return boundary;
}
function processPath(nodes) {
  const pathNode = nodes.find(
    (node) => node.type === "List" && node.children?.[0]?.type === "Atom" && node.children[0].value === "path"
  );
  if (!pathNode) {
    return {
      layer: nodes[1]?.type === "Atom" ? nodes[1].value : "F.Cu",
      width: nodes[2]?.type === "Atom" ? nodes[2].value : 200,
      coordinates: nodes.slice(3).filter(
        (node) => node.type === "Atom" && typeof node.value === "number"
      ).map((node) => node.value)
    };
  }
  const pathChildren = pathNode.children;
  return {
    layer: pathChildren[1]?.type === "Atom" ? pathChildren[1].value : "F.Cu",
    width: pathChildren[2]?.type === "Atom" ? pathChildren[2].value : 200,
    coordinates: pathChildren.slice(3).filter((node) => node.type === "Atom" && typeof node.value === "number").map((node) => node.value)
  };
}
function processRule(nodes) {
  const rule = {};
  rule.clearances = [];
  nodes.forEach((node) => {
    if (node.type === "List") {
      const [keyNode, ...rest] = node.children;
      if (keyNode.type === "Atom" && typeof keyNode.value === "string") {
        const key = keyNode.value;
        switch (key) {
          case "width":
            if (rest[0].type === "Atom" && typeof rest[0].value === "number") {
              rule.width = rest[0].value;
            }
            break;
          case "clearance":
            rule.clearances.push(processClearance(node.children));
            break;
        }
      }
    }
  });
  return rule;
}
function processClearance(nodes) {
  const clearance = {};
  if (nodes[1].type === "Atom" && typeof nodes[1].value === "number") {
    clearance.value = nodes[1].value;
  }
  for (let i = 2; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.type === "List") {
      const [keyNode, valueNode] = node.children;
      if (keyNode.type === "Atom" && keyNode.value === "type" && valueNode.type === "Atom" && typeof valueNode.value === "string") {
        clearance.type = valueNode.value;
      }
    }
  }
  return clearance;
}
function processPlacement(nodes) {
  const placement = {
    components: []
  };
  nodes.forEach((node) => {
    if (node.type === "List" && node.children[0].type === "Atom" && node.children[0].value === "component") {
      placement.components.push(processComponent(node.children));
    }
  });
  return placement;
}
function processComponent(nodes) {
  const component = {
    name: nodes[1].type === "Atom" && typeof nodes[1].value === "string" ? nodes[1].value : "",
    places: []
  };
  nodes.slice(2).forEach((node) => {
    if (node.type === "List" && node.children[0].type === "Atom" && node.children[0].value === "place") {
      component.places.push(processPlace(node.children));
    }
  });
  return component;
}
function processPlace(nodes) {
  const places = {};
  if (nodes.length < 2 || nodes[0].type !== "Atom" || nodes[0].value !== "place") {
    throw new Error("Invalid place format: missing basic structure");
  }
  if (nodes[1].type === "Atom" && typeof nodes[1].value === "string") {
    places.refdes = nodes[1].value;
  } else {
    throw new Error("Invalid place format: invalid refdes");
  }
  const coordIndex = 2;
  if (coordIndex + 3 < nodes.length) {
    if (nodes[coordIndex].type === "Atom" && typeof nodes[coordIndex].value === "number" && nodes[coordIndex + 1].type === "Atom" && typeof nodes[coordIndex + 1].value === "number" && nodes[coordIndex + 2].type === "Atom" && typeof nodes[coordIndex + 2].value === "string" && nodes[coordIndex + 3].type === "Atom" && typeof nodes[coordIndex + 3].value === "number") {
      places.x = nodes[coordIndex].value;
      places.y = nodes[coordIndex + 1].value;
      places.side = nodes[coordIndex + 2].value;
      places.rotation = nodes[coordIndex + 3].value;
    }
  }
  for (let i = coordIndex + 4; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.type === "List" && node.children && node.children[0].type === "Atom" && node.children[0].value === "PN" && node.children[1] && node.children[1].type === "Atom") {
      places.PN = String(node.children[1].value);
      break;
    }
  }
  places.PN = places.PN || "";
  places.side = places.side || "front";
  places.rotation = places.rotation || 0;
  return places;
}
function processLibrary(nodes) {
  const library = {
    images: [],
    padstacks: []
  };
  nodes.forEach((node) => {
    if (node.type === "List") {
      const [keyNode, ...rest] = node.children;
      if (keyNode.type === "Atom" && typeof keyNode.value === "string") {
        const key = keyNode.value;
        switch (key) {
          case "image":
            library.images.push(processImage(node.children));
            break;
          case "padstack":
            library.padstacks.push(processPadstack(node.children));
            break;
        }
      }
    }
  });
  return library;
}
function processImage(nodes) {
  const image = {};
  if (nodes[1].type === "Atom" && typeof nodes[1].value === "string") {
    image.name = nodes[1].value;
  }
  image.outlines = [];
  image.pins = [];
  nodes.slice(2).forEach((node) => {
    if (node.type === "List") {
      const [keyNode, ...rest] = node.children;
      if (keyNode.type === "Atom" && typeof keyNode.value === "string") {
        const key = keyNode.value;
        if (key === "outline") {
          image.outlines.push(processOutline(node.children));
        } else if (key === "pin") {
          const pin = processPin(node.children);
          if (pin) image.pins.push(pin);
        }
      }
    }
  });
  return image;
}
function processOutline(nodes) {
  const outline = {};
  nodes.forEach((node) => {
    if (node.type === "List" && node.children[0].type === "Atom" && node.children[0].value === "path") {
      outline.path = processPath(node.children);
    }
  });
  return outline;
}
function processPin(nodes) {
  const pin = {};
  try {
    if (nodes[1]?.type !== "Atom") {
      debug10("Unsupported pin padstack_name format:", nodes);
      return null;
    }
    pin.padstack_name = String(nodes[1].value);
    const pinNumber = getPinNum(nodes);
    if (pinNumber === null) return null;
    pin.pin_number = pinNumber;
    let xValue;
    let yValue;
    for (let i = 3; i < nodes.length; i++) {
      const node = nodes[i];
      const nextNode = nodes[i + 1];
      if (node.type === "Atom") {
        if (xValue === void 0) {
          if (typeof node.value === "number") {
            if (nextNode?.type === "Atom" && String(nextNode.value).toLowerCase().startsWith("e")) {
              xValue = Number(`${node.value}${nextNode.value}`);
              i++;
            } else {
              xValue = node.value;
            }
          }
        } else if (yValue === void 0) {
          if (typeof node.value === "number") {
            if (nextNode?.type === "Atom" && String(nextNode.value).toLowerCase().startsWith("e")) {
              yValue = Number(`${node.value}${nextNode.value}`);
              i++;
            } else {
              yValue = node.value;
            }
          }
        }
      }
    }
    if (typeof xValue !== "number" || typeof yValue !== "number") {
      throw new Error(`Invalid coordinates: x=${xValue}, y=${yValue}`);
    }
    pin.x = xValue;
    pin.y = yValue;
    return pin;
  } catch (error) {
    console.error("Pin processing error:", error);
    console.error("Problematic nodes:", JSON.stringify(nodes, null, 2));
    throw error;
  }
}
function processPadstack(nodes) {
  const padstack = {};
  if (nodes[1].type === "Atom" && typeof nodes[1].value === "string") {
    padstack.name = nodes[1].value;
  }
  padstack.shapes = [];
  padstack.attach = "off";
  nodes.slice(2).forEach((node) => {
    if (node.type === "List") {
      const [keyNode, ...rest] = node.children;
      if (keyNode.type === "Atom" && typeof keyNode.value === "string") {
        const key = keyNode.value;
        if (key === "shape") {
          padstack.shapes.push(processShape(node.children));
        } else if (key === "attach") {
          if (rest[0].type === "Atom" && typeof rest[0].value === "string") {
            padstack.attach = rest[0].value;
          }
        } else if (key === "hole") {
          if (rest[0]?.type === "Atom") {
            if (typeof rest[0].value === "number") {
              padstack.hole = { shape: "circle", diameter: rest[0].value };
            } else if (rest[0].value === "oval" && rest[1]?.type === "Atom" && rest[2]?.type === "Atom") {
              padstack.hole = {
                shape: "oval",
                width: rest[1].value,
                height: rest[2].value
              };
            }
          }
        }
      }
    }
  });
  return padstack;
}
function processShape(nodes) {
  const [_, shapeContentNode, ...rest] = nodes;
  if (shapeContentNode.type === "List") {
    const [shapeTypeNode, layerNode, ...shapeData] = shapeContentNode.children;
    if (shapeTypeNode.type === "Atom" && typeof shapeTypeNode.value === "string") {
      const shapeType = shapeTypeNode.value;
      switch (shapeType) {
        case "polygon":
          return processPolygonShape(shapeContentNode.children);
        case "circle":
          return processCircleShape(shapeContentNode.children);
        case "rect":
          return processRectShape(shapeContentNode.children);
        case "path":
          return processPathShape(shapeContentNode.children);
      }
    }
  }
  console.error("Shape processing error for nodes:", nodes);
  throw new Error(`Unknown shape type for nodes: ${JSON.stringify(nodes)}`);
}
function processRectShape(nodes) {
  if (nodes.length < 6) {
    throw new Error("Invalid rect shape format: insufficient nodes");
  }
  if (nodes[0].type === "Atom" && nodes[0].value === "rect" && nodes[1].type === "Atom" && typeof nodes[1].value === "string" && nodes[2].type === "Atom" && typeof nodes[2].value === "number" && nodes[3].type === "Atom" && typeof nodes[3].value === "number" && nodes[4].type === "Atom" && typeof nodes[4].value === "number" && nodes[5].type === "Atom" && typeof nodes[5].value === "number") {
    return {
      shapeType: "rect",
      layer: nodes[1].value,
      coordinates: [
        nodes[2].value,
        nodes[3].value,
        nodes[4].value,
        nodes[5].value
      ]
    };
  }
  throw new Error("Invalid rect shape format");
}
function processPolygonShape(nodes) {
  const polygon = {
    shapeType: "polygon"
  };
  if (nodes[1].type === "Atom" && typeof nodes[1].value === "string" && nodes[2].type === "Atom" && typeof nodes[2].value === "number") {
    polygon.layer = nodes[1].value;
    polygon.width = nodes[2].value;
    polygon.coordinates = [];
    for (let i = 3; i < nodes.length; i++) {
      const coordNode = nodes[i];
      if (coordNode.type === "Atom" && typeof coordNode.value === "number") {
        polygon.coordinates.push(coordNode.value);
      } else {
        throw new Error("Invalid coordinate in polygon shape");
      }
    }
    return polygon;
  } else {
    throw new Error("Invalid polygon shape format");
  }
}
function processCircleShape(nodes) {
  const circle = {
    shapeType: "circle"
  };
  const shapeNodes = nodes[0].value === "shape" ? nodes[1].children : nodes;
  if (shapeNodes[1]?.type === "Atom" && typeof shapeNodes[1].value === "string" && shapeNodes[2]?.type === "Atom" && typeof shapeNodes[2].value === "number") {
    circle.layer = shapeNodes[1].value;
    circle.diameter = shapeNodes[2].value;
    return circle;
  } else {
    const coords = shapeNodes.slice(2).filter((n) => n.type === "Atom" && typeof n.value === "number");
    if (coords.length >= 3) {
      if (shapeNodes[1]?.type === "Atom") {
        circle.layer = String(shapeNodes[1].value);
        circle.diameter = Number(coords[2].value);
        return circle;
      }
      throw new Error("Invalid circle shape format: missing layer");
    }
    throw new Error("Invalid circle shape format");
  }
}
function processNetwork(nodes) {
  const network = {
    nets: [],
    classes: []
  };
  nodes.forEach((node) => {
    if (node.type === "List") {
      const [keyNode, ...rest] = node.children;
      if (keyNode.type === "Atom" && typeof keyNode.value === "string") {
        const key = keyNode.value;
        if (key === "net") {
          network.nets.push(processNet(node.children));
        } else if (key === "class") {
          network.classes.push(processClass(node.children));
        }
      }
    }
  });
  return network;
}
function processNet(nodes) {
  const net = {};
  if (nodes[1].type === "Atom" && typeof nodes[1].value === "string") {
    net.name = nodes[1].value;
  } else {
    net.name = nodes[1].value?.toString();
    debug10("net name was not a string", net.name);
  }
  nodes.slice(2).forEach((node) => {
    if (node.type === "List" && node.children[0].type === "Atom" && node.children[0].value === "pins") {
      net.pins = node.children.slice(1).map((pinNode) => {
        if (pinNode.type === "Atom" && typeof pinNode.value === "string") {
          return pinNode.value;
        } else {
          throw new Error("Invalid pin in net");
        }
      });
    }
  });
  return net;
}
function processClass(nodes) {
  const classObj = {};
  if (nodes[1].type === "Atom" && typeof nodes[1].value === "string" && nodes[2].type === "Atom" && typeof nodes[2].value === "string") {
    classObj.name = nodes[1].value;
    classObj.description = nodes[2].value;
  }
  let i = 3;
  classObj.net_names = [];
  while (i < nodes.length && nodes[i].type === "Atom" && typeof nodes[i].value === "string" && nodes[i].value !== void 0) {
    classObj.net_names.push(nodes[i].value);
    i++;
  }
  while (i < nodes.length) {
    const node = nodes[i];
    if (node.type === "List") {
      const [keyNode, ...rest] = node.children;
      if (keyNode.type === "Atom" && typeof keyNode.value === "string") {
        const key = keyNode.value;
        if (key === "circuit") {
          classObj.circuit = processCircuit(node.children.slice(1));
        } else if (key === "rule") {
          classObj.rule = processRule(node.children.slice(1));
        }
      }
    }
    i++;
  }
  return classObj;
}
function processCircuit(nodes) {
  const circuit = {};
  nodes.forEach((node) => {
    if (node.type === "List" && node.children[0].type === "Atom" && node.children[0].value === "use_via") {
      if (node.children[1].type === "Atom" && typeof node.children[1].value === "string") {
        circuit.use_via = node.children[1].value;
      }
    }
  });
  return circuit;
}
function processWiring(nodes) {
  const wiring = {
    wires: []
  };
  nodes.forEach((node) => {
    if (node.type === "List" && node.children[0].type === "Atom" && node.children[0].value === "wire") {
      wiring.wires.push(processWire(node.children));
    }
    if (node.type === "List" && node.children[0].type === "Atom" && node.children[0].value === "via") {
      const via = processVia(node.children);
      if (via) wiring.wires.push(via);
    }
  });
  return wiring;
}
function processVia(nodes) {
  const coords = getViaCoords(nodes);
  if (!coords) {
    return null;
  }
  const wire = {
    path: {
      layer: "all",
      // vias connect all layers
      width: 0,
      // width is defined by the padstack
      coordinates: [coords.x, coords.y]
    },
    type: "via"
  };
  const netNode = nodes.find(
    (node) => node.type === "List" && node.children?.[0]?.type === "Atom" && node.children[0].value === "net"
  );
  if (netNode?.children?.[1]?.type === "Atom") {
    wire.net = String(netNode.children[1].value);
  }
  return wire;
}
function processWire(nodes) {
  const wire = {};
  nodes.forEach((node) => {
    if (node.type === "List") {
      const [keyNode, ...rest] = node.children;
      if (keyNode.type === "Atom" && typeof keyNode.value === "string") {
        const key = keyNode.value;
        switch (key) {
          case "path":
            wire.path = processPath(node.children);
            break;
          case "polyline_path":
            if (rest.length >= 2 && rest[0].type === "Atom" && typeof rest[0].value === "string" && rest[1].type === "Atom" && typeof rest[1].value === "number") {
              wire.polyline_path = {
                layer: rest[0].value,
                width: rest[1].value,
                coordinates: rest.slice(2).filter(
                  (n) => n.type === "Atom" && typeof n.value === "number"
                ).map((n) => n.value)
              };
            }
            break;
          case "net":
            if (rest[0].type === "Atom" && typeof rest[0].value === "string") {
              wire.net = rest[0].value;
            }
            break;
          case "clearance_class":
            if (rest[0].type === "Atom" && typeof rest[0].value === "string") {
              wire.clearance_class = rest[0].value;
            }
            break;
          case "type":
            if (rest[0].type === "Atom" && typeof rest[0].value === "string") {
              wire.type = rest[0].value;
            }
            break;
        }
      }
    }
  });
  return wire;
}
function processSessionNode(ast) {
  const session = {
    is_dsn_session: true,
    filename: ast.children[1].type === "Atom" ? ast.children[1].value : "session",
    placement: {
      resolution: { unit: "um", value: 10 },
      components: []
    },
    routes: {
      resolution: { unit: "um", value: 10 },
      parser: {
        string_quote: "",
        host_version: "",
        space_in_quoted_tokens: "",
        host_cad: ""
      },
      network_out: {
        nets: []
      }
    }
  };
  const placementNode = ast.children.find(
    (child) => child.type === "List" && child.children?.[0].type === "Atom" && child.children[0].value === "placement"
  );
  if (placementNode) {
    const resolutionNode = placementNode.children.find(
      (child) => child.type === "List" && child.children?.[0].type === "Atom" && child.children[0].value === "resolution"
    );
    if (resolutionNode) {
      session.placement.resolution = processResolution(resolutionNode.children);
    }
    session.placement.components = processPlacement(
      placementNode.children.slice(1)
    ).components;
  }
  const routesNode = ast.children.find(
    (child) => child.type === "List" && child.children?.[0].type === "Atom" && child.children[0].value === "routes"
  );
  if (routesNode) {
    const libraryNode = routesNode.children.find(
      (child) => child.type === "List" && child.children?.[0].type === "Atom" && child.children[0].value === "library_out"
    );
    if (libraryNode) {
      session.routes.library_out = {
        images: [],
        padstacks: libraryNode.children.filter(
          (child) => child.type === "List" && child.children?.[0].type === "Atom" && child.children[0].value === "padstack"
        ).map((padstackNode) => processPadstack(padstackNode.children))
      };
    }
    const networkNode = routesNode.children.find(
      (child) => child.type === "List" && child.children?.[0].type === "Atom" && child.children[0].value === "network_out"
    );
    if (networkNode) {
      const netNodes = networkNode.children.filter(
        (child) => child.type === "List" && child.children?.[0].type === "Atom" && child.children[0].value === "net"
      );
      session.routes.network_out.nets = netNodes.map((netNode) => {
        const netName = netNode.children[1].value;
        const wireNodes = netNode.children.filter(
          (child) => child.type === "List" && child.children?.[0].type === "Atom" && child.children[0].value === "wire"
        );
        const viaNodes = netNode.children.filter(
          (child) => child.type === "List" && child.children?.[0].type === "Atom" && child.children[0].value === "via"
        );
        const net = {
          name: netName,
          wires: wireNodes.map((wireNode) => ({
            path: processPath(wireNode.children.slice(1)),
            net: netName,
            type: "route"
          })),
          vias: viaNodes.map((viaNode) => ({
            x: viaNode.children[2].value,
            y: viaNode.children[3].value
          }))
        };
        return net;
      });
    }
  }
  return session;
}
function processPathShape(nodes) {
  if (nodes[1]?.type === "Atom" && typeof nodes[1].value === "string" && nodes[2]?.type === "Atom" && typeof nodes[2].value === "number") {
    return {
      shapeType: "path",
      layer: nodes[1].value,
      width: nodes[2].value,
      coordinates: nodes.slice(3).filter(
        (node) => node.type === "Atom" && typeof node.value === "number"
      ).map((node) => node.value)
    };
  }
  throw new Error("Invalid path shape format");
}

// lib/dsn-pcb/dsn-json-to-circuit-json/parse-dsn-to-circuit-json.ts
var parseDsnToCircuitJson = (dsnString) => {
  const dsnJson = parseDsnToDsnJson(dsnString);
  const circuitJson = convertDsnJsonToCircuitJson(dsnJson);
  return circuitJson;
};
export {
  convertCircuitJsonToDsnJson,
  convertCircuitJsonToDsnSession,
  convertCircuitJsonToDsnString,
  convertDsnJsonToCircuitJson,
  convertDsnPcbToCircuitJson,
  convertDsnSessionToCircuitJson,
  mergeDsnSessionIntoDsnPcb,
  parseDsnToCircuitJson,
  parseDsnToDsnJson,
  processLibrary,
  processNetwork,
  processPCB,
  processParser,
  processPlacement,
  processResolution,
  processStructure,
  processWiring,
  stringifyDsnJson,
  stringifyDsnSession
};
//# sourceMappingURL=index.js.map