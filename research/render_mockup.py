from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import math

OUT = Path(__file__).parent
S = 2
im = Image.new('RGB', (1600*S, 1100*S), '#edf0f5')
d = ImageDraw.Draw(im)
INK, MUTED, BLUE, LINE = '#17223a', '#697589', '#5964e8', '#e0e5ee'

def font(size, style='regular'):
    names = {'regular':'segoeui.ttf', 'bold':'segoeuib.ttf', 'math':'cambria.ttc', 'hand':'segoepr.ttf'}
    return ImageFont.truetype('C:/Windows/Fonts/'+names[style], int(size*S))

def text(x,y,s,size=18,color=INK,style='regular'):
    d.text((x*S,y*S),s,font=font(size,style),fill=color)

def rect(box,fill,r=0,outline=None,width=1):
    d.rounded_rectangle(tuple(int(v*S) for v in box),radius=r*S,fill=fill,outline=outline,width=width*S)

def line(points,fill=INK,width=2):
    d.line([(int(x*S),int(y*S)) for x,y in points],fill=fill,width=width*S,joint='curve')

def pill(x,y,w,label,fill='#ffffff',color=MUTED):
    rect((x,y,x+w,y+36),fill,18)
    text(x+15,y+6,label,16,color)

text(48,24,'A whiteboard that follows your thinking.',36,style='bold')
text(50,79,'Interaction concept  /  Point with your pen. Speak naturally. Keep everything editable.',19,MUTED)
pill(1367,33,181,'STATIC MOCKUP',fill='#e1e5ed')

rect((42,145,1558,947),'#dfe4ed',30)
rect((40,136,1560,936),'#ffffff',28)
rect((41,220,1559,907),'#fcfcfe')
for x in range(64,1550,24):
    for y in range(240,898,24):
        d.ellipse((x*S,y*S,(x+1)*S,(y+1)*S),fill='#e0e5ee')
text(65,161,'‹',30,MUTED)
text(102,166,'Calculus notebook',22,style='bold')
text(329,170,'/  Exploring functions',17,MUTED)
pill(1100,163,126,'Saved locally',fill='#edf7f2',color='#418165')
pill(1238,163,111,'Import PDF',fill='#f1f3f8')
pill(1364,163,147,'Export / Share',fill='#f1f3f8')
line([(41,220),(1558,220)],LINE,1)

# A compact tool strip leaves the page dominant.
rect((63,253,144,720),'#ffffff',22,LINE)
for y,icon,label in [(281,'↖','Select'),(364,'✎','Pencil'),(447,'✧','Magic'),(530,'Aa','Clean'),(613,'⌫','Erase')]:
    if label == 'Magic':
        rect((73,y-10,134,y+65),'#eef0ff',15)
    if label == 'Clean':
        text(86,y,icon,25,MUTED,'bold')
    elif label == 'Select':
        line([(92,y+3),(92,y+29),(99,y+21),(112,y+19),(92,y+3)],MUTED,2)
    elif label == 'Pencil':
        line([(90,y+28),(94,y+16),(108,y+2),(114,y+8),(100,y+22),(90,y+28)],MUTED,2)
    elif label == 'Magic':
        line([(90,y+29),(111,y+8)],BLUE,3)
        line([(91,y+4),(91,y+13)],BLUE,2)
        line([(87,y+8),(96,y+8)],BLUE,2)
        line([(113,y+23),(113,y+32)],BLUE,2)
        line([(109,y+27),(118,y+27)],BLUE,2)
    else:
        line([(89,y+20),(103,y+5),(116,y+18),(106,y+29),(96,y+29),(89,y+20)],MUTED,2)
    text(81,y+40,label,13,BLUE if label == 'Magic' else MUTED)

text(207,253,'01   EXPLORE',14,MUTED,'bold')
text(205,286,'What changes when we',23,style='hand')
text(205,324,'move the curve up?',23,style='hand')
line([(208,368),(315,364),(389,369),(495,366)],'#a6b0d0',2)

rect((203,411,606,555),'#ffffff',16,LINE)
text(225,430,'VOICE → FORMATTED MATH',12,MUTED,'bold')
text(247,471,'∫',52,style='math')
text(274,467,'5',16,style='math')
text(274,519,'2',16,style='math')
text(300,490,'sin(x) dx',32,style='math')
pill(454,493,122,'Editable',fill='#f1f3f8')

rect((203,581,606,738),'#fff9ec',16)
text(225,599,'VOICE → GEOMETRY',12,'#9c7a32','bold')
line([(257,634),(257,704),(357,704),(257,634)],'#bc8a39',2)
line([(257,691),(270,691),(270,704)],'#bc8a39',1)
text(237,624,'A',14,'#9c7a32')
text(240,705,'B',14,'#9c7a32')
text(360,699,'C',14,'#9c7a32')
text(401,638,'“Add a right',18,style='hand')
text(401,673,'triangle here.”',18,style='hand')

# The focused object is model-backed and has a stable identity.
rect((654,267,1517,755),'#f0f1ff',23,BLUE,2)
rect((666,279,1505,743),'#ffffff',16)
pill(680,288,147,'Magic focus',fill='#eceeff',color=BLUE)
text(849,292,'y = x² + 3',27,style='math')
pill(1304,290,176,'x range: 0 to 10',fill='#f1f3f8')
for px,py in [(654,267),(1517,267),(654,755),(1517,755)]:
    rect((px-4,py-4,px+4,py+4),'#ffffff',2,BLUE,2)

# Exact y=x²+3 graph, x=[0,10], y=[0,110].
gx,gy,gw,gh=733,356,698,316
for k in range(11):
    x=gx+k*gw/10
    line([(x,gy),(x,gy+gh)],'#edf0f5',1)
    if k%2==0: text(x-6,gy+gh+10,str(k),14,MUTED)
for y in [0,20,40,60,80,100]:
    py=gy+gh-y/110*gh
    line([(gx,py),(gx+gw,py)],'#edf0f5',1)
    text(gx-37,py-10,str(y),14,MUTED)
line([(gx,gy),(gx,gy+gh),(gx+gw,gy+gh)],'#a4afc1',2)
pts=[(gx+i/400*gw,gy+gh-((i/400*10)**2+3)/110*gh) for i in range(401)]
line(pts,BLUE,4)
text(gx+gw+10,gy+gh-8,'x',17,MUTED,'math')
text(gx-4,gy-26,'y',17,MUTED,'math')
text(689,711,'Updated constant to +3  ·  Range changed to 0–10',15,MUTED)
pill(1400,701,82,'Undo',fill='#f1f3f8')

# Proposed assistant cursor follows committed canvas actions.
d.polygon([(1455*S,633*S),(1455*S,661*S),(1463*S,653*S),(1476*S,652*S)],fill=BLUE)
pill(1350,666,130,'Assistant',fill='#eceeff',color=BLUE)

# Voice bar: visible focus + transcript + explicit recording state.
rect((334,806,1301,886),'#18243e',23)
for k,h in enumerate([11,22,34,19,40,28,16,31,12]):
    rect((361+k*6,846-h/2,364+k*6,846+h/2),'#a7b0ff',2)
text(434,821,'“Actually, make the range zero to ten.”',21,'#ffffff')
text(435,855,'Listening  ·  Focus: selected graph',14,'#bbc5dc')
pill(1133,828,144,'Stop listening',fill='#33415e',color='#ffffff')
text(69,906,'Page 1 of 1',14,MUTED)
text(1386,906,'−    100%    +',14,MUTED)

for x,num,title,body in [
    (60,'1','Point','Circle a region or select an existing object.'),
    (568,'2','Speak','Dictate math, request a plot, or ask for help.'),
    (1080,'3','Refine','Say “+3 instead.” The same object updates.')]:
    rect((x,984,x+34,1018),'#dde1ff',17)
    text(x+12,987,num,18,BLUE,'bold')
    text(x+47,981,title,23,style='bold')
    text(x,1031,body,17,MUTED)

im.resize((1600,1100),Image.Resampling.LANCZOS).save(OUT/'magic-whiteboard-concept.png')
print(OUT/'magic-whiteboard-concept.png')
