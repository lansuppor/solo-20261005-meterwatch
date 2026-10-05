// 轻量 CSV 解析:支持标准双引号字段、"" 转义双引号、字段内换行,
// 以及 LF / CRLF / CR 换行。空行(完全无字符的行)被跳过。

export interface CsvRecord {
  fields: string[];
  /** 记录起始行号(1 起)。 */
  line: number;
}

export class CsvError extends Error {}

/**
 * 解析 CSV 文本为记录数组。
 * 语法错误(引号未闭合、引号后出现非法字符等)抛出 CsvError,消息含行号。
 */
export function parseCsv(text: string): CsvRecord[] {
  if (text.startsWith('﻿')) text = text.slice(1); // 去掉 UTF-8 BOM

  const records: CsvRecord[] = [];
  let fields: string[] = [];
  let field = '';
  let inQuotes = false;
  let afterQuote = false; // 刚结束一个引号字段,只接受逗号/换行/EOF
  let started = false; // 当前记录是否已有任何字符
  let line = 1;
  let recordLine = 1;

  const endField = (): void => {
    fields.push(field);
    field = '';
    afterQuote = false;
  };
  const endRecord = (): void => {
    endField();
    records.push({ fields, line: recordLine });
    fields = [];
    started = false;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
          afterQuote = true;
        }
      } else {
        if (ch === '\n') line++;
        field += ch;
      }
      continue;
    }
    if (afterQuote) {
      if (ch === ',') {
        endField();
      } else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        line++;
        endRecord();
        recordLine = line;
      } else {
        throw new CsvError(`line ${line}: unexpected character after closing quote`);
      }
      continue;
    }
    if (ch === '"') {
      if (field !== '') {
        throw new CsvError(`line ${line}: unexpected quote inside unquoted field`);
      }
      inQuotes = true;
      started = true;
    } else if (ch === ',') {
      endField();
      started = true;
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      line++;
      if (started || fields.length > 0 || field !== '') {
        endRecord();
      }
      recordLine = line;
    } else {
      field += ch;
      started = true;
    }
  }

  if (inQuotes) throw new CsvError(`line ${recordLine}: unterminated quoted field`);
  if (started || fields.length > 0 || field !== '') endRecord();
  return records;
}
