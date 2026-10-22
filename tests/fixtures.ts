export function board(count = 2) {
  return { title: '月光邮局', style: '手绘动画', characters: [{ id: 'fox', name: '小狐狸', description: '橙色皮毛，蓝围巾' }],
    shots: Array.from({ length: count }, (_, i) => ({ id: `shot-${i + 1}`, title: `镜头 ${i + 1}`, description: `狐狸送出第 ${i + 1} 封信`, camera: '中景缓推', imagePrompt: '狐狸与月光邮局', videoPrompt: '狐狸缓缓走向邮局', duration: 1, characterIds: ['fox'] })) };
}
