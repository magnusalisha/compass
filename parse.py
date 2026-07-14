import re, json, os, glob

# ---- canonical terpene vocabulary -------------------------------------
CANON = {
    'alpha-pinene':'alpha-Pinene','a-pinene':'alpha-Pinene','α-pinene':'alpha-Pinene',
    'beta-pinene':'beta-Pinene','b-pinene':'beta-Pinene','β-pinene':'beta-Pinene',
    'beta-myrcene':'beta-Myrcene','myrcene':'beta-Myrcene','β-myrcene':'beta-Myrcene',
    'limonene':'Limonene','d-limonene':'Limonene',
    'terpinolene':'Terpinolene',
    'linalool':'Linalool',
    'beta-caryophyllene':'beta-Caryophyllene','caryophyllene':'beta-Caryophyllene','β-caryophyllene':'beta-Caryophyllene',
    'alpha-humulene':'alpha-Humulene','humulene':'alpha-Humulene','α-humulene':'alpha-Humulene',
    'alpha-bisabolol':'alpha-Bisabolol','bisabolol':'alpha-Bisabolol','α-bisabolol':'alpha-Bisabolol',
    'ocimene':'Ocimene','farnesene':'Farnesene','valencene':'Valencene','guaiol':'Guaiol',
    'geraniol':'Geraniol','camphene':'Camphene','sabinene':'Sabinene','menthol':'Menthol',
    'eucalyptol':'Eucalyptol','citronellol':'Citronellol','isopulegol':'Isopulegol',
    'caryophyllene oxide':'Caryophyllene oxide',
    'alpha-terpinene':'alpha-Terpinene','α-terpinene':'alpha-Terpinene',
    'gamma-terpinene':'gamma-Terpinene',
    'alpha-terpineol':'Terpineol','terpineol':'Terpineol',
    'alpha-phellandrene':'alpha-Phellandrene','α-phellandrene':'alpha-Phellandrene',
    'p-cymene':'p-Cymene','carene':'Carene','3-carene':'Carene',
    'fenchol':'Fenchol','fenchyl alcohol':'Fenchol',
    'sabinene hydrate':'Sabinene hydrate','alpha-cedrene':'alpha-Cedrene',
    'cis-nerolidol':'cis-Nerolidol','trans-nerolidol':'trans-Nerolidol','nerolidol':'Nerolidol',
}

# aroma/flavor descriptors — what each terpene actually smells like.
AROMA = {
    'beta-Myrcene':'earthy, musky, mango',
    'Limonene':'citrus, lemon, bright',
    'beta-Caryophyllene':'pepper, spice, woody',
    'Terpinolene':'sharp, piney, herbal, fresh',
    'Linalool':'floral, lavender',
    'alpha-Pinene':'pine, sharp, forest',
    'beta-Pinene':'pine, herbal',
    'alpha-Humulene':'hops, earthy, woody',
    'alpha-Bisabolol':'chamomile, sweet, floral',
    'Ocimene':'sweet, herbal, tropical',
    'Farnesene':'green apple, woody',
    'Terpineol':'lilac, clove',
    'Fenchol':'pine, lime, camphor',
    'Guaiol':'pine, woody',
    'Valencene':'orange, sweet citrus',
    'Nerolidol':'floral, woody, apple',
    'Carene':'cedar, sweet pine',
    'alpha-Terpinene':'citrus, woody',
    'Camphene':'damp woods, fir',
    'Geraniol':'rose, floral',
    'Eucalyptol':'mint, eucalyptus',
    'p-Cymene':'citrus, woody',
    'alpha-Phellandrene':'mint, citrus, pepper',
}

def canon(name):
    k = name.strip().lower().replace('–','-').replace('_',' ')
    k = re.sub(r'\s+', ' ', k)
    k = k.replace('alpha ', 'alpha-').replace('beta ', 'beta-').replace('gamma ', 'gamma-')
    return CANON.get(k)

def val(tok):
    """Return float % or 0.0 for ND / <LOQ / <MRL style non-detects."""
    t = tok.strip()
    if t.upper() in ('ND','NR','NT','<MRL','< MRL',''): return 0.0
    if t.startswith('<'): return 0.0
    try: return float(t)
    except ValueError: return None

def parse(text):
    """Pull terpenes (% w/w) from a COA regardless of which of the 3 labs made it."""
    terps, total = {}, None
    for raw in text.splitlines():
        line = raw.strip()
        if not line: continue

        m = re.match(r'^(TOTAL TERPENES|Total Terpenes[^0-9]*)\s+(.*)$', line, re.I)
        if m:
            nums = re.findall(r'<?[\d.]+', m.group(2))
            # Kaycha: LOQ LIMIT PASS RESULT% mg/g  -> % is 2nd from last
            if len(nums) >= 4: total = val(nums[-2])
            elif nums: total = val(nums[0])
            continue

        # split "NAME  n n n n" -> name part + numeric tail
        m = re.match(r'^([A-Za-zαβγ\-\s,\.0-9]+?)\s+((?:(?:<\s?)?[\d.]+|ND|NR|PASS|FAIL|None|TESTED|%|w/w|\s)+)$', line)
        if not m: continue
        cname = canon(m.group(1))
        if not cname: continue

        toks = [t for t in re.findall(r'<\s?[\d.]+|ND|NR|[\d.]+', m.group(2)) if t not in ('10',)]
        nums = [val(t) for t in re.findall(r'<\s?[\d.]+|ND|NR|[\d.]+', m.group(2))]
        allt = re.findall(r'<\s?[\d.]+|ND|NR|[\d.]+', m.group(2))
        if not allt: continue

        pct = None
        if 'PASS' in m.group(2) or 'FAIL' in m.group(2):
            # Kaycha: LOQ LIMIT [PASS] RESULT% mg/g
            if len(allt) >= 4: pct = val(allt[-2])
        elif len(allt) == 3:
            # DRS/Confident: LOQ  %  mg/g
            pct = val(allt[1])
        elif len(allt) == 2:
            # Green Analytics: RESULT%  MRL
            pct = val(allt[0])
        elif len(allt) == 1:
            pct = val(allt[0])

        if pct is None: continue
        # keep the biggest reading if a terpene shows up on more than one page
        terps[cname] = max(pct, terps.get(cname, 0.0))

    if total is None and terps:
        total = round(sum(terps.values()), 3)
    return terps, total

def profile(terps, total):
    """Rank terpenes and turn the top ones into an aroma sentence."""
    hits = sorted([(k,v) for k,v in terps.items() if v > 0], key=lambda x: -x[1])
    dom = [k for k,_ in hits[:3]]
    notes = []
    for k in dom:
        for w in AROMA.get(k,'').split(', '):
            if w and w not in notes: notes.append(w)
    return hits, dom, notes[:5]

# ---- Total THC (% w/w) --------------------------------------------------
def thc(text):
    # Green Analytics: "Total THC [ ... ] 31.050 310.503"
    m = re.search(r'Total THC\s*\[[^\]]*\]\s*([\d.]+)', text)
    if m: return float(m.group(1))
    # Kaycha: "Total THC" then "31.5084%" on the next line
    m = re.search(r'Total THC\s*[\r\n]+\s*([\d.]+)\s*%', text)
    if m: return float(m.group(1))
    # DRS/Confident: "20.50%" then "Total THC"
    m = re.search(r'([\d.]+)\s*%\s*[\r\n]+\s*Total THC', text)
    if m: return float(m.group(1))
    return None

# ---- What people report ------------------------------------------------
# NOT pharmacology and NOT a medical claim. This is the register strain
# databases live in: how customers commonly DESCRIBE these chemovars.
# NY prohibits claims that a product treats/cures/prevents anything.
REPORTED = {
    'Terpinolene':        ('heady and alert',      'up'),
    'Limonene':           ('bright and talkative', 'up'),
    'alpha-Pinene':       ('clear-headed',         'up'),
    'beta-Pinene':        ('clear-headed',         'up'),
    'Ocimene':            ('light and lively',     'up'),
    'beta-Myrcene':       ('heavy and relaxed',    'down'),
    'Linalool':           ('mellow and soft',      'down'),
    'beta-Caryophyllene': ('calm in the body',     'down'),
    'alpha-Humulene':     ('grounded, low-key',    'down'),
    'alpha-Bisabolol':    ('gentle and easy',      'down'),
    'Farnesene':          ('settled',              'down'),
    'Terpineol':          ('mellow',               'down'),
    'Guaiol':             ('grounded',             'down'),
    'Fenchol':            ('clear',                'up'),
}

def lean(terps):
    """Which direction does this chemovar's profile point, and how strongly?"""
    up = sum(v for k, v in terps.items() if REPORTED.get(k, (None,''))[1] == 'up')
    dn = sum(v for k, v in terps.items() if REPORTED.get(k, (None,''))[1] == 'down')
    tot = up + dn
    if tot == 0: return 'mixed', 0
    bal = (up - dn) / tot                    # -1 = fully down, +1 = fully up
    if bal >  0.35: return 'lifting', bal
    if bal < -0.35: return 'settling', bal
    return 'mixed', bal

def reported_words(dominant):
    return [REPORTED[k][0] for k in dominant if k in REPORTED][:2]

# ---- Confidence: don't let a faded profile masquerade as a chemotype -----
# Caryophyllene and humulene are sesquiterpenes: heavy, high boiling point.
# Myrcene/limonene/pinene/terpinolene are monoterpenes: volatile, and the
# first to evaporate through drying, grinding, and shelf time. A product that
# has lost its terpenes therefore looks sesquiterpene-dominant REGARDLESS of
# the strain that went in — which reads as "settling" to a naive model.
# Typical intact flower runs 1-3% total. Below ~0.8%, the ranking is telling
# you about age and handling as much as about genetics.
SESQUI = {'beta-Caryophyllene','alpha-Humulene','alpha-Bisabolol','Guaiol',
          'Farnesene','Valencene','Caryophyllene oxide','cis-Nerolidol','trans-Nerolidol'}

def confidence(terps, total):
    if not total: return 'unknown', None
    sq = sum(v for k,v in terps.items() if k in SESQUI)
    sq_share = sq/total if total else 0
    if total < 0.8 and sq_share > 0.5:
        return 'faint', ("Low total terpenes and mostly heavy sesquiterpenes — the volatile "
                         "ones have likely evaporated. Read the label, not this profile.")
    if total < 0.8:
        return 'faint', "Low total terpenes. Character is muted either way."
    if total < 1.2:
        return 'moderate', None
    return 'strong', None
