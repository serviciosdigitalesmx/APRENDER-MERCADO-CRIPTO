# APRENDER-MERCADO-CRIPTO

CryptoLearn Pro: simulador educativo de criptomonedas.

## Incluye
- Precios reales de Binance Spot.
- Velas en vivo por activo e intervalo.
- Simulacion de compras/ventas con saldo virtual en MXN.
- Panel educativo con EMA, RSI, volumen y contexto de mercado.

## Ejecutar local

```bash
python3 -m http.server 8080
```

Abrir en navegador: `http://localhost:8080`

## Notas tecnicas

- Si WebSocket de Binance falla por red o region, la app usa polling REST automatico para seguir actualizando datos.
- No ejecuta operaciones reales; es solo simulacion educativa.

## Radar Bot + Memoria (Google Sheets)

1. Abre `apps_script/Code.gs` en un proyecto de Google Apps Script ligado a tu Sheet.
2. Publica como Web App (acceso: Anyone with the link).
3. Pega la URL en el campo `Apps Script Web App URL` del panel Radar y haz clic en `Guardar URL memoria`.
4. Activa `Auto-trade sim` si quieres que el bot ejecute operaciones simuladas con el mejor setup.
