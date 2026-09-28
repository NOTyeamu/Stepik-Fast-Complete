using System;

class Program
{
    static void Main()
    {
        string stroka = Console.ReadLine();
        string novayaStroka = "";

        foreach (char bukva in stroka)
        {
            if (char.IsLetterOrDigit(bukva))
            {
                novayaStroka = novayaStroka + bukva;
            }
        }

        Console.WriteLine(novayaStroka);
    }
}