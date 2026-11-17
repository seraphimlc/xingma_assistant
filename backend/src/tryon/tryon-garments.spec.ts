import { classifyTryOnImage, publicProductName, selectTryOnColors, toPublicTryOnDto } from './tryon-garments';

const hang = {
  id: 'm-hang',
  url: 'https://cdn.example/hang.jpg',
  filename: '挂拍-米白.jpg',
  type: 'image',
  meta: { role: 'main', colorHint: '米白' },
};
const navyBody = {
  id: 'm-navy',
  url: 'https://cdn.example/navy-body.jpg',
  filename: '上身.jpg',
  type: 'image',
  meta: { role: 'on_model', colorHint: '藏青' },
};
const chart = {
  id: 'm-chart',
  url: 'https://cdn.example/chart.jpg',
  filename: '01.jpg',
  type: 'image',
  meta: { role: 'size_chart' },
};
const tag = {
  id: 'm-tag',
  url: 'https://cdn.example/tag.jpg',
  filename: '吊牌.jpg',
  type: 'image',
  meta: { role: 'unknown' },
};
const report = {
  id: 'm-lab',
  url: 'https://cdn.example/lab.jpg',
  filename: '检测报告.png',
  type: 'image',
  meta: { role: 'lab_report' },
};

describe('try-on garment pick', () => {
  it('drops size charts, hangtags and lab reports', () => {
    expect(classifyTryOnImage(chart)).toBe('forbid');
    expect(classifyTryOnImage(tag)).toBe('forbid');
    expect(classifyTryOnImage(report)).toBe('forbid');
    expect(classifyTryOnImage({ ...chart, filename: 'size-chart.jpg', meta: {} })).toBe('forbid');
  });

  it('prefers hang or flatlay over an on-body shot for the shared main image', () => {
    const picked = selectTryOnColors(
      [navyBody, hang, chart, tag, report],
      [
        { id: 'sku-white', color: '米白', status: 'active' },
        { id: 'sku-camel', color: '驼', status: 'active' },
      ],
    );
    const camel = picked.find((c) => c.id === 'sku-camel');
    expect(camel?.sourceUrl).toBe(hang.url);
    expect(camel?.mediaId).toBe(hang.id);
    expect(picked.find((c) => c.mediaId === chart.id)).toBeUndefined();
  });

  it('uses a color-specific image and reuses the main image when a color has none', () => {
    const picked = selectTryOnColors(
      [hang, navyBody],
      [
        { id: 'sku-white', color: '米白', status: 'active' },
        { id: 'sku-navy', color: '藏青', status: 'active' },
        { id: 'sku-pink', color: '藕粉', status: 'active' },
      ],
    );
    expect(picked.find((c) => c.name === '藏青')?.sourceUrl).toBe(navyBody.url);
    expect(picked.find((c) => c.name === '藕粉')?.sourceUrl).toBe(hang.url);
    expect(new Set(picked.map((c) => c.sourceUrl)).size).toBe(2);
  });

  it('hides try-on when every image is a document', () => {
    expect(selectTryOnColors([chart, tag, report], [{ id: 'a', color: '米白', status: 'active' }])).toEqual([]);
    expect(
      classifyTryOnImage({ id: 'doc', url: 'https://cdn.example/a.jpg', filename: '02.jpg', documentLike: true }),
    ).toBe('forbid');
  });

  it('does not expose style numbers, tags or staff fields', () => {
    const colors = selectTryOnColors([hang], [{ id: 'sku-white', color: '米白', status: 'active' }]);
    const dto = toPublicTryOnDto('绞花圆领 V202601011200AB12', 'p1', colors);
    expect(dto.name).toBe('绞花圆领');
    expect(dto.available).toBe(true);
    expect(Object.keys(dto).sort()).toEqual(['available', 'colors', 'name']);
    expect(Object.keys(dto.colors[0]).sort()).toEqual(['id', 'imageUrl', 'name']);
    expect(JSON.stringify(dto)).not.toMatch(/styleNo|provisional|needReview|sharePolicy|levelId|V202601011200AB12/);
    expect(publicProductName('V202601011200AB')).toBe('商品');
  });

  it('skips inactive skus and still offers a default chip when there is no color', () => {
    const picked = selectTryOnColors([hang], [{ id: 'old', color: '停售色', status: 'off' }]);
    expect(picked).toEqual([
      expect.objectContaining({ id: 'default', name: '默认', sourceUrl: hang.url }),
    ]);
  });
});
