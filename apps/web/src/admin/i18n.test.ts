import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import ts from 'typescript';
import { adminHref, adminLocale, labelName, translate, kk } from './i18n';

afterEach(() => vi.unstubAllGlobals());
describe('staff RU/KK dictionary', () => {
  it('covers all static translations used by staff screens', () => {
    const missing: string[] = [];
    for (const name of readdirSync(new URL('.', import.meta.url)).filter(
      (n) => /\.tsx?$/.test(n) && !n.includes('.test.') && n !== 'i18n.ts',
    )) {
      const source = readFileSync(new URL(name, import.meta.url), 'utf8');
      const file = ts.createSourceFile(
        name,
        source,
        ts.ScriptTarget.Latest,
        true,
        name.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      function visit(n: ts.Node) {
        if (
          ts.isCallExpression(n) &&
          n.expression.getText(file) === 't' &&
          n.arguments[0] &&
          ts.isStringLiteral(n.arguments[0])
        ) {
          const key = n.arguments[0].text.replace(/\s+/g, ' ').trim();
          if (!kk[key]) missing.push(name + ':' + key);
        }
        if (
          ts.isJsxText(n) &&
          /[А-Яа-яЁё]/.test(n.text) &&
          !['Русский', 'Қазақша'].includes(n.text.trim())
        )
          missing.push(name + ':untranslated JSX');
        ts.forEachChild(n, visit);
      }
      visit(file);
    }
    expect(missing).toEqual([]);
  });
  it('keeps the selected language in staff navigation and catalogue labels', () => {
    vi.stubGlobal('location', { search: '?lang=kk' });
    expect(adminLocale()).toBe('kk');
    expect(adminHref('/admin/staff')).toBe('/admin/staff?lang=kk');
    expect(labelName({ nameRu: 'Тест', nameKk: 'Сынақ' })).toBe('Сынақ');
    expect(translate('Войти')).toBe('Кіру');
    expect(translate(' Добавить ')).toBe(' Қосу ');
  });
  it('defaults safely to Russian without a persisted locale', () => {
    vi.stubGlobal('location', { search: '?lang=invalid' });
    expect(adminLocale()).toBe('ru');
    expect(translate('Войти')).toBe('Войти');
  });
});
