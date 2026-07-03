import ExcelJS from 'exceljs';
import type { FeedRow } from './catalogImport.ts';

// Turns an uploaded Meta catalog-feed workbook (.xlsx) into keyed rows for the
// importer. Meta's template has two header rows — long descriptions, then the
// machine field keys (id, title, price, ...) — with data below; a plain export
// may put the keys on row 1. We locate the key row by finding the one that has
// an "id" column, then treat every row after it as data.

const MAX_HEADER_SCAN_ROWS = 2;

const cellText = (value: ExcelJS.CellValue): string => {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'object') {
    // Rich text / hyperlink / formula result cells.
    const obj = value as { text?: string; result?: unknown; hyperlink?: string };
    if (typeof obj.text === 'string') {
      return obj.text.trim();
    }
    if (obj.result !== undefined) {
      return String(obj.result).trim();
    }
    if (typeof obj.hyperlink === 'string') {
      return obj.hyperlink.trim();
    }
  }
  return String(value).trim();
};

export const parseMetaFeedWorkbook = async (buffer: Buffer): Promise<FeedRow[]> => {
  // TODO: the 5 MB multer cap is on the COMPRESSED file; exceljs inflates the
  // whole workbook into memory, so a crafted xlsx can expand far beyond that.
  // Cap worksheet.rowCount (and per-row cell count) before mapping rows.
  const workbook = new ExcelJS.Workbook();
  // @types/node's generic Buffer differs from exceljs's expected Buffer param;
  // the runtime value is a valid Buffer, so cast to exceljs's own param type.
  type XlsxBuffer = Parameters<ExcelJS.Xlsx['load']>[0];
  await workbook.xlsx.load(buffer as unknown as XlsxBuffer);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) {
    throw new Error('The uploaded file has no worksheet.');
  }

  // Find the field-key row (contains an "id" column) within the first rows.
  let keyRowNumber = -1;
  for (let r = 1; r <= Math.min(MAX_HEADER_SCAN_ROWS, worksheet.rowCount); r += 1) {
    const values = worksheet.getRow(r).values as ExcelJS.CellValue[];
    if (values.some((v) => cellText(v).toLowerCase() === 'id')) {
      keyRowNumber = r;
      break;
    }
  }
  if (keyRowNumber === -1) {
    throw new Error('Could not find the feed header row (no "id" column).');
  }

  // Column index -> field key.
  const keys: Record<number, string> = {};
  worksheet.getRow(keyRowNumber).eachCell({ includeEmpty: false }, (cell, col) => {
    const key = cellText(cell.value);
    if (key) {
      keys[col] = key;
    }
  });

  const rows: FeedRow[] = [];
  for (let r = keyRowNumber + 1; r <= worksheet.rowCount; r += 1) {
    const row: FeedRow = {};
    let hasValue = false;
    worksheet.getRow(r).eachCell({ includeEmpty: false }, (cell, col) => {
      const key = keys[col];
      const text = cellText(cell.value);
      if (key && text) {
        row[key] = text;
        hasValue = true;
      }
    });
    if (hasValue) {
      rows.push(row);
    }
  }

  return rows;
};
