function doPost(e) {
  try {
    var props = PropertiesService.getScriptProperties();
    var spreadsheetId = props.getProperty('SPREADSHEET_ID');
    var ss = spreadsheetId ? SpreadsheetApp.openById(spreadsheetId) : SpreadsheetApp.getActiveSpreadsheet();

    if (!ss) {
      ss = SpreadsheetApp.create('APRENDER-MERCADO-CRIPTO Memory');
      spreadsheetId = ss.getId();
      props.setProperty('SPREADSHEET_ID', spreadsheetId);
    }

    if (!ss) {
      throw new Error('No se encontró Spreadsheet. Configura SPREADSHEET_ID en Script Properties.');
    }

    var sheet = ss.getSheetByName('memory');
    if (!sheet) {
      sheet = ss.insertSheet('memory');
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

function doGet() {
  return ContentService
    .createTextOutput(JSON.stringify({ ok: true, service: 'memory-api' }))
    .setMimeType(ContentService.MimeType.JSON);
}

function initMemorySheet() {
  var props = PropertiesService.getScriptProperties();
  var spreadsheetId = props.getProperty('SPREADSHEET_ID');
  var ss;

  if (spreadsheetId) {
    ss = SpreadsheetApp.openById(spreadsheetId);
  } else {
    ss = SpreadsheetApp.create('APRENDER-MERCADO-CRIPTO Memory');
    spreadsheetId = ss.getId();
    props.setProperty('SPREADSHEET_ID', spreadsheetId);
  }

  var sheet = ss.getSheetByName('memory');
  if (!sheet) {
    sheet = ss.insertSheet('memory');
  }

  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['timestamp', 'symbol', 'decision', 'score', 'up', 'down', 'notes']);
  } else {
    var header = sheet.getRange(1, 1, 1, 7).getValues()[0];
    var expected = ['timestamp', 'symbol', 'decision', 'score', 'up', 'down', 'notes'];
    var mismatch = expected.some(function(v, i) { return header[i] !== v; });
    if (mismatch) {
      sheet.insertRows(1, 1);
      sheet.getRange(1, 1, 1, 7).setValues([expected]);
    }
  }

  return {
    ok: true,
    spreadsheetId: spreadsheetId,
    spreadsheetUrl: ss.getUrl(),
    scriptId: ScriptApp.getScriptId()
  };
}
