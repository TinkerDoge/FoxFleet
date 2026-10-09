// noVNC ships untyped ES modules (MPL-2.0); only the two entry points we use are declared.
declare module '*/novnc/core/rfb.js' { const RFB: any; export default RFB }
declare module '*/novnc/core/input/keysym.js' { const KeyTable: Record<string, number>; export default KeyTable }
