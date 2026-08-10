REY PIZZARIA — versão com editor de imagens

Esta versão mantém as promoções e adiciona um editor de recorte antes de cada upload.

Como funciona:
1. No painel /admin, escolha uma imagem do computador.
2. Antes de enviar, abre um editor.
3. Arraste a foto para escolher o enquadramento.
4. Use o controle de zoom.
5. Clique em "Usar esta imagem".
6. O navegador gera uma imagem já recortada no formato correto e envia para Flask.
7. Flask salva a imagem em static/uploads/ e data.json guarda somente o caminho.

Formatos usados no recorte:
- Produto: 4:3, 1200x900, JPG.
- Promoção: 4:3, 1200x900, JPG.
- Post do dia: 16:9, 1200x675, JPG.
- Logo: 1:1, 900x900, PNG.

O objetivo é que a foto que aparece no site já tenha o mesmo enquadramento do espaço reservado, sem esticar ou deformar a imagem.

Para executar:
python app.py

Cliente: http://127.0.0.1:5000/
Admin:   http://127.0.0.1:5000/admin
