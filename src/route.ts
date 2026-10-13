app.get('/ping', (req, res) => {
  return res.json({ status: 'ok', time: new Date() });
});