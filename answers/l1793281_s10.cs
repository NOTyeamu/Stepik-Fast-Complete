using System;

class Program
{
    static void Main()
    {
        string stroka = Console.ReadLine();

        foreach (char bukva in stroka)
        {
            if (bukva == '#')
            {
                break;
            }

            Console.Write(bukva);
        }
        
        Console.WriteLine();
    }
}