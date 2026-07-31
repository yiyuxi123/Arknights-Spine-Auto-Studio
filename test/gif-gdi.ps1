Add-Type -AssemblyName System.Drawing
$gifPath = Join-Path (Get-Location) 'test/out.gif'
$expectedPath = Join-Path (Get-Location) 'test/gif-expected.json'
$expected = Get-Content -LiteralPath $expectedPath -Raw | ConvertFrom-Json
$bmp = [System.Drawing.Bitmap]::new($gifPath)
$dimension = [System.Drawing.Imaging.FrameDimension]::Time
$frameCount = $bmp.GetFrameCount($dimension)
$result = [ordered]@{ width = $bmp.Width; height = $bmp.Height; frameCount = $frameCount; samples = @() }
foreach ($sample in $expected.samples) {
  $bmp.SelectActiveFrame($dimension, $sample.frame) | Out-Null
  $c = $bmp.GetPixel($sample.x, $sample.y)
  $result.samples += [ordered]@{ frame = $sample.frame; x = $sample.x; y = $sample.y; r = $c.R; g = $c.G; b = $c.B }
}
$bmp.Dispose()
$result | ConvertTo-Json -Depth 4 -Compress | Set-Content -LiteralPath (Join-Path (Get-Location) 'test/gif-actual.json') -Encoding UTF8
Write-Host "GDI+ decoded: $($result.width)x$($result.height) frames=$frameCount"