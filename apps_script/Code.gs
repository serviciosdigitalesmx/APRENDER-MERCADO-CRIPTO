function doPost(e) {
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('memory');
    if (!sheet) {
      sheet = SpreadsheetApp.getActiveSpreadsheet().insertSheet('memory');
      sheet.appendRow(['timestamp', 'symbol', 'decision', 'score', 'up', 'down', 'notes']);
    }

    var data = JSON.parse(e.postData.contents || '{}');
    sheet.appendRow([
      data.ts || new Date().toISOString(),
      data.symbol || '',
      data.decision || '',
      data.score || '',
      data.up || '',
      data.down || '',
      data.notes || ''
    ]);

    return ContentService
      .createTextOutput(JSON.stringify({ ok: true }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
